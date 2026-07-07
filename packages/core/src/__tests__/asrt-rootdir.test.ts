import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sandboxManager = vi.hoisted(() => ({
  isSupportedPlatform: vi.fn(() => true),
  isSandboxingEnabled: vi.fn(() => false),
  initialize: vi.fn(async () => {}),
  updateConfig: vi.fn(() => {}),
  wrapWithSandboxArgv: vi.fn(async () => ({
    argv: [process.execPath, '-e', 'process.stdout.write("sandbox-ok")'],
    env: process.env,
  })),
  cleanupAfterCommand: vi.fn(() => {}),
}));

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: sandboxManager,
}));

describe('AsrtSandboxClient rootDir (caller-owned external root)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('roots the session at rootDir even on a perRun client and never deletes it on cleanup', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const external = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-external-root-'));
    await fsp.writeFile(path.join(external, 'issue.json'), '{}');
    try {
      const client = new AsrtSandboxClient({ perRun: true, cleanup: 'delete' });

      const session = await client.create({ runId: 'run/1', rootDir: external });
      expect(await fsp.realpath(session.root)).toBe(await fsp.realpath(external));

      await session.cleanup();
      // perRun+delete client defaults must not apply: the external dir survives.
      await expect(fsp.readFile(path.join(external, 'issue.json'), 'utf-8')).resolves.toBe('{}');
    } finally {
      await fsp.rm(external, { recursive: true, force: true });
    }
  });

  it('rootDir wins over a configured fixed root', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const fixed = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-fixed-root-'));
    const external = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-external-root-'));
    try {
      const client = new AsrtSandboxClient({ perRun: false, root: fixed });
      const session = await client.create({ rootDir: external });
      expect(await fsp.realpath(session.root)).toBe(await fsp.realpath(external));
    } finally {
      await fsp.rm(fixed, { recursive: true, force: true });
      await fsp.rm(external, { recursive: true, force: true });
    }
  });

  it('resume with rootDir reuses the external root and never restores a snapshot over it', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const external = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-external-root-'));
    await fsp.writeFile(path.join(external, 'live.txt'), 'real-workdir-state');
    const restore = vi.fn(async () => {});
    try {
      const client = new AsrtSandboxClient({
        perRun: true,
        snapshotBackend: {
          kind: 'test',
          persist: vi.fn(async () => 'ref-1'),
          restorable: vi.fn(async () => true),
          restore,
        },
      });

      const session = await client.resume(
        {
          backend: 'asrt',
          snapshot: {
            id: 's1',
            backend: 'test',
            ref: 'ref-1',
            root: '/tmp/elsewhere',
            createdAt: new Date().toISOString(),
          },
        },
        { rootDir: external },
      );

      expect(await fsp.realpath(session.root)).toBe(await fsp.realpath(external));
      expect(restore).not.toHaveBeenCalled();
      await expect(fsp.readFile(path.join(external, 'live.txt'), 'utf-8')).resolves.toBe(
        'real-workdir-state',
      );
    } finally {
      await fsp.rm(external, { recursive: true, force: true });
    }
  });
});
