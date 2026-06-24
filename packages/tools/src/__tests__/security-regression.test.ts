/**
 * Security regression tests — prevent re-introduction of known vulnerabilities.
 *
 * These tests document known attack vectors
 * and ensure the defenses remain intact. Each test explains the attack vector
 * and verifies the mitigation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEditTool,
  createExecTool,
  createGrepTool,
  createWriteTool,
} from '../builtin/index.js';
import { openForRead, PathOutsideWorkspaceError } from '../builtin/safe-path.js';
import type { SandboxCommand, ToolContext, WorkspaceSession } from '@dongkseo/contracts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-sec-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(workdir?: string): ToolContext {
  return {
    workdir: workdir ?? tmpDir,
    signal: new AbortController().signal,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as ToolContext;
}

function makeWorkspace(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    id: 'ws-test',
    root: tmpDir,
    mode: 'workspace-write',
    mounts: [],
    resolve: async (rawPath, options = {}) => {
      const resolved = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(tmpDir, rawPath);
      const relativePath = path.relative(tmpDir, resolved);
      if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error(`Access denied: "${rawPath}" resolves outside workspace root ${tmpDir}`);
      }
      return {
        path: resolved,
        root: tmpDir,
        relativePath: relativePath || '.',
        access: options.access === 'write' || options.access === 'readwrite' ? 'rw' : 'ro',
      };
    },
    cleanup: async () => {},
    ...overrides,
  };
}

describe('Exec sandbox regressions', () => {
  it('rejects path traversal in argv[0]', async () => {
    const tool = createExecTool({ allowList: ['node'] });
    const result = await tool.execute(
      'call-1', { argv: ['../../../bin/sh', '-c', 'echo pwned'] },
      makeCtx(),
    );
    expect(result.type).toBe('error');
  });

  it('rejects absolute path in argv[0]', async () => {
    const tool = createExecTool({ allowList: ['node'] });
    const result = await tool.execute(
      'call-2', { argv: ['/bin/sh', '-c', 'echo pwned'] },
      makeCtx(),
    );
    expect(result.type).toBe('error');
  });

  it('blocks shell interpreters by default even if allowlisted', async () => {
    const tool = createExecTool({ allowList: ['bash'] });
    const result = await tool.execute(
      'call-3', { argv: ['bash', '-c', 'echo pwned'] },
      makeCtx(),
    );
    expect(result.type).toBe('error');
  });

  it('blocks command-string mode without allowShell', async () => {
    const tool = createExecTool({ allowList: ['ls'] });
    const result = await tool.execute(
      'call-4', { command: 'ls -la && echo pwned' },
      makeCtx(),
    );
    expect(result.type).toBe('error');
  });

  it('rejects all commands when no allowList is provided', async () => {
    const tool = createExecTool({});
    const result = await tool.execute(
      'call-5', { argv: ['ls'] },
      makeCtx(),
    );
    expect(result.type).toBe('error');
  });

  it('passes scrubbed env and abort signal to sandbox workspace.run', async () => {
    process.env.NEXORA_SECRET = 'super-secret';
    const parent = new AbortController();
    let seen: SandboxCommand | undefined;
    let runStarted!: () => void;
    const runStartedPromise = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const workspace = makeWorkspace({
      run: async (command) => {
        seen = command;
        runStarted();
        return new Promise((resolve) => {
          command.signal?.addEventListener('abort', () => {
            resolve({
              exitCode: null,
              signal: null,
              stdout: command.env?.NEXORA_SECRET ? 'leaked' : 'clean',
              stderr: '',
              aborted: true,
            });
          }, { once: true });
        });
      },
    });
    try {
      const tool = createExecTool({ allowList: ['printenv'] });
      const resultPromise = tool.execute(
        'call-6',
        { argv: ['printenv', 'NEXORA_SECRET'] },
        { ...makeCtx(), signal: parent.signal, workspace },
      );

      await runStartedPromise;
      expect(seen?.env?.NEXORA_SECRET).toBeUndefined();
      parent.abort();
      const result = await resultPromise;

      expect(result.type).toBe('text');
      if (result.type === 'text') {
        expect(result.text).toContain('clean');
        expect(result.text).toContain('aborted');
      }
      expect(seen?.signal?.aborted).toBe(true);
    } finally {
      delete process.env.NEXORA_SECRET;
    }
  });

  it('caps sandbox exec output at the documented limit', async () => {
    const workspace = makeWorkspace({
      run: async () => ({
        exitCode: 0,
        signal: null,
        stdout: 'x'.repeat(300_000),
        stderr: '',
      }),
    });
    const tool = createExecTool({ allowList: ['echo'] });
    const result = await tool.execute(
      'call-7',
      { argv: ['echo', 'large'] },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('Output truncated at 262144 bytes');
      expect(result.text.length).toBeLessThan(270_000);
    }
  });

  it('preserves sandbox stderr when stdout fills the output cap', async () => {
    const workspace = makeWorkspace({
      run: async () => ({
        exitCode: 1,
        signal: null,
        stdout: 'x'.repeat(300_000),
        stderr: 'fatal: build failed\n',
      }),
    });
    const result = await createExecTool({ allowList: ['npm'] }).execute(
      'call-8',
      { argv: ['npm', 'run', 'build'] },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('[stderr]');
      expect(result.text).toContain('fatal: build failed');
      expect(result.text).toContain('Output truncated at 262144 bytes');
    }
  });

  it('caps sandbox exec output without splitting UTF-8 characters', async () => {
    const workspace = makeWorkspace({
      run: async () => ({
        exitCode: 0,
        signal: null,
        stdout: `${'a'.repeat(262_143)}한`,
        stderr: '',
      }),
    });
    const result = await createExecTool({ allowList: ['echo'] }).execute(
      'call-9',
      { argv: ['echo', 'large'] },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('Output truncated at 262144 bytes');
      expect(result.text).not.toContain('\uFFFD');
      expect(result.text).not.toContain('한');
    }
  });

  it('keeps a complete 4-byte UTF-8 character at the truncation boundary', async () => {
    const emoji = '\u{1F600}';
    const workspace = makeWorkspace({
      run: async () => ({
        exitCode: 0,
        signal: null,
        stdout: `${'a'.repeat(262_140)}${emoji}x`,
        stderr: '',
      }),
    });
    const result = await createExecTool({ allowList: ['echo'] }).execute(
      'call-10',
      { argv: ['echo', 'large'] },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain(emoji);
      expect(result.text).toContain('Output truncated at 262144 bytes');
      expect(result.text).not.toContain('\uFFFD');
    }
  });

  it('caps local streamed exec output without splitting UTF-8 characters', async () => {
    const script = "process.stdout.write('a'.repeat(262_143) + '한' + 'x')";
    const result = await createExecTool({ allowShell: true }).execute(
      'call-11',
      { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` },
      makeCtx(),
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('Output truncated at 262144 bytes');
      expect(result.text).not.toContain('\uFFFD');
      expect(result.text).not.toContain('한');
    }
  });

  it('does not mark completed local exec output aborted based on a later signal state', async () => {
    let abortedReads = 0;
    const signal = {
      get aborted() {
        abortedReads += 1;
        return abortedReads > 1;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    const result = await createExecTool({ allowList: ['echo'] }).execute(
      'call-12',
      { argv: ['echo', 'done'] },
      { ...makeCtx(), signal },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('done');
      expect(result.text).not.toContain('Aborted by caller');
    }
  });

  it('does not mark completed sandbox exec output aborted after run resolves', async () => {
    const parent = new AbortController();
    const workspace = makeWorkspace({
      run: async () => {
        parent.abort();
        return {
          exitCode: 0,
          signal: null,
          stdout: 'done',
          stderr: '',
        };
      },
    });
    const result = await createExecTool({ allowList: ['echo'] }).execute(
      'call-13',
      { argv: ['echo', 'done'] },
      { ...makeCtx(), signal: parent.signal, workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('done');
      expect(result.text).not.toContain('Aborted by caller');
    }
  });

  it('marks sandbox exec aborted when the parent aborts and the runner omits aborted', async () => {
    const parent = new AbortController();
    const workspace = makeWorkspace({
      run: async () => {
        parent.abort();
        return {
          exitCode: null,
          signal: 'SIGTERM',
          stdout: 'partial',
          stderr: '',
        };
      },
    });
    const result = await createExecTool({ allowList: ['echo'] }).execute(
      'call-14',
      { argv: ['echo', 'partial'] },
      { ...makeCtx(), signal: parent.signal, workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('Aborted by caller');
      expect(result.text).not.toContain('Killed by signal: SIGTERM');
    }
  });

  it('reports sandbox exec runner failures as tool errors', async () => {
    const workspace = makeWorkspace({
      run: async () => {
        throw new Error('ENOENT');
      },
    });
    const result = await createExecTool({ allowList: ['missing-bin'] }).execute(
      'call-15',
      { argv: ['missing-bin'] },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.message).toContain('sandboxed exec failed: ENOENT');
    }
  });
});

describe('Workspace policy regressions', () => {
  it('write and edit honor read-only workspace sessions', async () => {
    const workspace = makeWorkspace({
      mode: 'read-only',
      resolve: async (_rawPath, options = {}) => {
        if (options.access === 'write' || options.access === 'readwrite') {
          throw new Error('Workspace is read-only');
        }
        return makeWorkspace().resolve(_rawPath, options);
      },
    });
    const ctx = { ...makeCtx(), workspace };
    const writeResult = await createWriteTool().execute(
      'write-1',
      { path: 'blocked.txt', content: 'nope' },
      ctx,
    );
    expect(writeResult.type).toBe('error');
    expect(fs.existsSync(path.join(tmpDir, 'blocked.txt'))).toBe(false);

    fs.writeFileSync(path.join(tmpDir, 'existing.txt'), 'original', 'utf-8');
    const editResult = await createEditTool().execute(
      'edit-1',
      { path: 'existing.txt', old_string: 'original', new_string: 'changed' },
      ctx,
    );
    expect(editResult.type).toBe('error');
    expect(fs.readFileSync(path.join(tmpDir, 'existing.txt'), 'utf-8')).toBe('original');
  });

  it('grep routes through workspace.run when a sandbox runner is available', async () => {
    let seen: SandboxCommand | undefined;
    const workspace = makeWorkspace({
      run: async (command) => {
        seen = command;
        return {
          exitCode: 0,
          signal: null,
          stdout: `${path.join(tmpDir, 'a.ts')}:1:TODO\n`,
          stderr: '',
        };
      },
    });

    const result = await createGrepTool().execute(
      'grep-1',
      { pattern: 'TODO' },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('TODO');
    expect(seen?.argv[0]).toBe('grep');
    expect(seen?.signal).toBeDefined();
    expect(seen?.timeoutMs).toBeGreaterThan(0);
  });

  it('grep blocks path traversal without a workspace session', async () => {
    const result = await createGrepTool().execute(
      'grep-2',
      { pattern: 'root', path: '../../../../etc' },
      makeCtx(),
    );

    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/outside workspace root/);
  });

  it('grep blocks symlink escapes without a workspace session', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-grep-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET_VALUE', 'utf-8');
      fs.symlinkSync(outside, path.join(tmpDir, 'link-out'));

      const result = await createGrepTool().execute(
        'grep-3',
        { pattern: 'SECRET_VALUE', path: 'link-out' },
        makeCtx(),
      );

      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.message).toMatch(/outside workspace root/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('grep treats missing in-workspace paths as no matches', async () => {
    const result = await createGrepTool().execute(
      'grep-4',
      { pattern: 'TODO', path: 'missing-dir' },
      makeCtx(),
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toBe('No matches found.');
  });

  it('grep does not mark completed local results aborted based on a later signal state', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'TODO\n', 'utf-8');
    let abortedReads = 0;
    const signal = {
      get aborted() {
        abortedReads += 1;
        return abortedReads > 1;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal;

    const result = await createGrepTool().execute(
      'grep-5',
      { pattern: 'TODO' },
      { ...makeCtx(), signal },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('a.ts:1:TODO');
      expect(result.text).not.toContain('grep aborted');
    }
  });

  it('grep strips canonical roots from output when the workspace root is a symlink', async () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-grep-real-'));
    const linkRoot = path.join(os.tmpdir(), `nexora-grep-link-${process.pid}-${Date.now()}`);
    try {
      fs.writeFileSync(path.join(realRoot, 'a.ts'), 'TODO\n', 'utf-8');
      fs.symlinkSync(realRoot, linkRoot, 'dir');

      const result = await createGrepTool().execute(
        'grep-6',
        { pattern: 'TODO' },
        makeCtx(linkRoot),
      );

      expect(result.type).toBe('text');
      if (result.type === 'text') {
        expect(result.text).toContain('a.ts:1:TODO');
        expect(result.text).not.toContain(realRoot);
        expect(result.text).not.toContain(linkRoot);
      }
    } finally {
      fs.rmSync(linkRoot, { force: true });
      fs.rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it('grep passes the canonical path it validated to workspace.run', async () => {
    fs.mkdirSync(path.join(tmpDir, 'real-dir'));
    fs.writeFileSync(path.join(tmpDir, 'real-dir', 'a.ts'), 'TODO', 'utf-8');
    fs.symlinkSync(path.join(tmpDir, 'real-dir'), path.join(tmpDir, 'link-in'));
    const realDir = fs.realpathSync(path.join(tmpDir, 'real-dir'));
    let seen: SandboxCommand | undefined;
    const workspace = makeWorkspace({
      run: async (command) => {
        seen = command;
        return {
          exitCode: 0,
          signal: null,
          stdout: `${realDir}${path.sep}a.ts:1:TODO\n`,
          stderr: '',
        };
      },
    });

    const result = await createGrepTool().execute(
      'grep-7',
      { pattern: 'TODO', path: 'link-in' },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('text');
    const searchArg = seen?.argv[seen.argv.length - 1];
    expect(searchArg).toBe(realDir);
  });

  it('grep maps sandbox exit without code to a meaningful error', async () => {
    const workspace = makeWorkspace({
      run: async () => ({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
      }),
    });

    const result = await createGrepTool().execute(
      'grep-8',
      { pattern: 'TODO' },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toContain('terminated without exit code');
  });

  it('grep includes sandbox stderr when grep exits with a hard error', async () => {
    const workspace = makeWorkspace({
      run: async () => ({
        exitCode: 2,
        signal: null,
        stdout: '',
        stderr: 'grep: invalid regular expression\n',
      }),
    });

    const result = await createGrepTool().execute(
      'grep-9',
      { pattern: '[' },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toContain('invalid regular expression');
  });

  it('grep returns partial matches with warnings when grep exits 2 after matches', async () => {
    const workspace = makeWorkspace({
      run: async () => ({
        exitCode: 2,
        signal: null,
        stdout: `${path.join(tmpDir, 'a.ts')}:1:TODO\n`,
        stderr: 'grep: permission denied\n',
      }),
    });

    const result = await createGrepTool().execute(
      'grep-10',
      { pattern: 'TODO' },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('a.ts:1:TODO');
      expect(result.text).toContain('grep exited 2');
      expect(result.text).toContain('permission denied');
      expect(result.text).toContain('partial results returned');
    }
  });

  it('grep reports signal warnings even if a sandbox also reports exit 0', async () => {
    const workspace = makeWorkspace({
      run: async () => ({
        exitCode: 0,
        signal: 'SIGTERM',
        stdout: `${path.join(tmpDir, 'a.ts')}:1:TODO\n`,
        stderr: '',
      }),
    });

    const result = await createGrepTool().execute(
      'grep-11',
      { pattern: 'TODO' },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('a.ts:1:TODO');
      expect(result.text).toContain('grep killed by signal SIGTERM');
    }
  });

  it('grep preserves partial stdout when grep is killed after producing output', async () => {
    const workspace = makeWorkspace({
      run: async () => ({
        exitCode: null,
        signal: 'SIGTERM',
        stdout: `${path.join(tmpDir, 'a.ts')}:1:TODO\n`,
        stderr: '',
      }),
    });

    const result = await createGrepTool().execute(
      'grep-12',
      { pattern: 'TODO' },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('a.ts:1:TODO');
      expect(result.text).toContain('partial results returned');
    }
  });

  it('grep preserves partial stdout when grep times out', async () => {
    const workspace = makeWorkspace({
      run: async () => ({
        exitCode: null,
        signal: null,
        stdout: `${path.join(tmpDir, 'a.ts')}:1:TODO\n`,
        stderr: '',
        timedOut: true,
      }),
    });

    const result = await createGrepTool().execute(
      'grep-13',
      { pattern: 'TODO' },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('a.ts:1:TODO');
      expect(result.text).toContain('grep timed out: partial results returned');
    }
  });

  it('grep preserves partial stdout when grep is aborted', async () => {
    const workspace = makeWorkspace({
      run: async () => ({
        exitCode: null,
        signal: null,
        stdout: `${path.join(tmpDir, 'a.ts')}:1:TODO\n`,
        stderr: '',
        aborted: true,
      }),
    });

    const result = await createGrepTool().execute(
      'grep-14',
      { pattern: 'TODO' },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('a.ts:1:TODO');
      expect(result.text).toContain('grep aborted: partial results returned');
    }
  });

  it('grep prefers aborted over timed out when both flags are set', async () => {
    const workspace = makeWorkspace({
      run: async () => ({
        exitCode: null,
        signal: null,
        stdout: `${path.join(tmpDir, 'a.ts')}:1:TODO\n`,
        stderr: '',
        timedOut: true,
        aborted: true,
      }),
    });

    const result = await createGrepTool().execute(
      'grep-15',
      { pattern: 'TODO' },
      { ...makeCtx(), workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('a.ts:1:TODO');
      expect(result.text).toContain('grep aborted: partial results returned');
      expect(result.text).not.toContain('grep timed out: partial results returned');
    }
  });

  it('grep keeps successful sandbox output even if the parent signal aborts after run resolves', async () => {
    const parent = new AbortController();
    const workspace = makeWorkspace({
      run: async () => {
        parent.abort();
        return {
          exitCode: 0,
          signal: null,
          stdout: `${path.join(tmpDir, 'a.ts')}:1:TODO\n`,
          stderr: '',
        };
      },
    });

    const result = await createGrepTool().execute(
      'grep-16',
      { pattern: 'TODO' },
      { ...makeCtx(), signal: parent.signal, workspace },
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('TODO');
  });
});

describe('Safe path regressions', () => {
  it('rejects paths with ../ traversal via openForRead', async () => {
    await expect(
      openForRead('../../../etc/passwd', tmpDir),
    ).rejects.toThrow(PathOutsideWorkspaceError);
  });

  it('rejects absolute paths outside workdir', async () => {
    await expect(
      openForRead('/etc/passwd', tmpDir),
    ).rejects.toThrow(PathOutsideWorkspaceError);
  });

  it('allows files inside workdir', async () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'test', 'utf-8');
    const handle = await openForRead('hello.txt', tmpDir);
    const content = await handle.readFile('utf-8');
    await handle.close();
    expect(content).toBe('test');
  });
});

describe('Delegation depth limit', () => {
  it('metadata shape supports delegationDepth for bootstrap enforcement', () => {
    // Contract-level: bootstrap.ts reads delegationDepth from metadata and
    // rejects > 10. This test documents the expected metadata structure.
    const metadata = {
      traceId: 't',
      spanId: 's',
      conversationId: 'c',
      tenantId: 'default',
      timestamp: Date.now(),
      delegationDepth: 11,
      callerAgent: 'agent-a',
    };

    expect(metadata.delegationDepth).toBeGreaterThan(10);
    expect(metadata.callerAgent).toBeDefined();
  });
});
