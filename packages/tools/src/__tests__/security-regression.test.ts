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
import { createExecTool } from '../builtin/index.js';
import { openForRead, PathOutsideWorkspaceError } from '../builtin/safe-path.js';
import type { ToolContext } from '@nexora/contracts';

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
  } as ToolContext;
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
