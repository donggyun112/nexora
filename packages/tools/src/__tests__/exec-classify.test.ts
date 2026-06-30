import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExecTool } from '../builtin/exec.js';
import type { ToolContext, ToolDefinition } from '@dongkseo/contracts';
import {
  isReadOnlyShellCommand,
  isReadOnlyArgv,
  analyzeShellCommand,
} from '../builtin/bash/command-classify.js';

function ctx(workdir = process.cwd()): ToolContext {
  return {
    tenantId: 't',
    workdir,
    secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as ToolContext;
}

// ToolDefinition.isReadOnly/isConcurrencySafe are boolean | ((input?) => boolean).
const callBool = (
  v: ToolDefinition['isReadOnly'],
  input: unknown,
): boolean => (typeof v === 'function' ? v(input) : Boolean(v));

describe('command-classify: read-only shell classification', () => {
  it('classifies read-only single + pipeline commands', () => {
    expect(isReadOnlyShellCommand('ls -la')).toBe(true);
    expect(isReadOnlyShellCommand('cat a.txt | grep foo')).toBe(true);
    expect(isReadOnlyShellCommand('git status')).toBe(true);
    expect(isReadOnlyShellCommand('find . -name "*.ts"')).toBe(true);
  });

  it('fails closed on writes, unknown commands, and exec primitives', () => {
    expect(isReadOnlyShellCommand('cat a > out.txt')).toBe(false); // write redirect
    expect(isReadOnlyShellCommand('rm -rf x')).toBe(false); // not read-only
    expect(isReadOnlyShellCommand('git push')).toBe(false); // git non-read-only sub
    expect(isReadOnlyShellCommand('ls && rm x')).toBe(false); // one writer in sequence
    expect(isReadOnlyShellCommand('find . -exec rm {} ;')).toBe(false); // find -exec
    expect(isReadOnlyShellCommand('echo $(rm x)')).toBe(false); // inner command writes
  });

  it('classifies argv form directly (no shell parse)', () => {
    expect(isReadOnlyArgv(['ls', '-l'])).toBe(true);
    expect(isReadOnlyArgv(['git', 'log'])).toBe(true);
    expect(isReadOnlyArgv(['rm', 'x'])).toBe(false);
    expect(isReadOnlyArgv([])).toBe(false);
  });

  it('too-complex input fails closed', () => {
    expect(analyzeShellCommand('ls \x07evil').kind).not.toBe('simple'); // control char
    expect(isReadOnlyShellCommand('ls \x07evil')).toBe(false);
  });
});

describe('exec: read-only / concurrency metadata', () => {
  const exec = createExecTool({ allowShell: true, allowList: ['*'] });

  it('flags read commands read-only and concurrency-safe', () => {
    expect(callBool(exec.isReadOnly, { argv: ['ls'] })).toBe(true);
    expect(callBool(exec.isConcurrencySafe, { command: 'cat x | grep y' })).toBe(true);
  });

  it('flags writes / background launches not read-only', () => {
    expect(callBool(exec.isReadOnly, { argv: ['rm', 'x'] })).toBe(false);
    expect(callBool(exec.isReadOnly, { argv: ['ls'], run_in_background: true })).toBe(false);
    expect(callBool(exec.isConcurrencySafe, { command: 'cat x > out' })).toBe(false);
  });
});

describe('exec: shell-mode per-subcommand allowList enforcement', () => {
  it('rejects a pipeline subcommand not in the allowList', async () => {
    const exec = createExecTool({ allowShell: true, allowList: ['cat', 'ls'] });
    const res = await exec.execute('s1', { command: 'cat a | rm b' }, ctx());
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/not in allowList.*rm/);
  });

  it('fails closed when the command cannot be parsed cleanly', async () => {
    const exec = createExecTool({ allowShell: true, allowList: ['ls'] });
    const res = await exec.execute('s2', { command: 'ls \x07x' }, ctx());
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/could not be verified/);
  });

  it('wildcard allowList skips the gate', async () => {
    const exec = createExecTool({ allowShell: true, allowList: ['*'] });
    const res = await exec.execute('s3', { command: 'echo hi' }, ctx());
    expect(res.type).toBe('text');
    if (res.type === 'text') expect(res.text).toContain('hi');
  });
});

describe('exec: exit-code semantics', () => {
  const exec = createExecTool({ allowShell: true, allowList: ['*'] });

  it('treats grep exit 1 (no matches) as success, not error', async () => {
    const res = await exec.execute('x1', { command: 'echo hello | grep zzz' }, ctx());
    expect(res.type).toBe('text');
    if (res.type === 'text') {
      expect(res.text).toContain('No matches found');
      expect(res.text).not.toContain('[exit 1]');
    }
  });

  it('keeps default non-zero exit as failure for unmapped commands', async () => {
    const res = await exec.execute('x2', { command: 'false' }, ctx());
    expect(res.type).toBe('text');
    if (res.type === 'text') expect(res.text).toContain('[exit 1]');
  });
});

describe('exec: large output spills to a file in cwd', () => {
  const exec = createExecTool({ allowShell: true, allowList: ['*'] });

  it('writes over-cap output to cwd and points the model at the file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'exec-spill-'));
    try {
      // ~512KB of output — above the 256KB inline cap.
      const res = await exec.execute(
        'big1',
        { command: 'head -c 524288 /dev/zero | tr "\\0" "a"' },
        ctx(dir),
      );
      expect(res.type).toBe('text');
      if (res.type !== 'text') return;
      const m = /written to (\S+) — read this file/.exec(res.text);
      expect(m).not.toBeNull();
      const filePath = m![1];
      expect(filePath.startsWith(dir)).toBe(true);
      const full = readFileSync(filePath, 'utf-8');
      expect(full.length).toBeGreaterThanOrEqual(524288);
      // Inline body is still capped, not the whole 512KB.
      expect(res.text.length).toBeLessThan(524288);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not create a file for small output', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'exec-small-'));
    try {
      const res = await exec.execute('small1', { command: 'echo hi' }, ctx(dir));
      expect(res.type).toBe('text');
      if (res.type === 'text') {
        expect(res.text).toContain('hi');
        expect(res.text).not.toContain('written to');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
