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

describe('AsrtSandboxClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a per-run workspace and initializes ASRT with workspace-only write policy', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-test-'));
    try {
      const client = new AsrtSandboxClient({
        baseDir,
        allowedDomains: ['api.github.com'],
        cleanup: 'delete',
      });

      const session = await client.create({ runId: 'run/1' });

      expect(session.root.startsWith(baseDir)).toBe(true);
      expect(sandboxManager.initialize).toHaveBeenCalledTimes(1);
      const config = sandboxManager.initialize.mock.calls[0][0];
      expect(config.network.allowedDomains).toEqual(['api.github.com']);
      expect(config.filesystem.allowWrite).toContain(session.root);
      expect(config.filesystem.allowRead).toContain(session.root);

      await session.cleanup();
      await expect(fsp.stat(session.root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('runs commands through ASRT wrapped argv', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-test-'));
    try {
      const client = new AsrtSandboxClient({ baseDir });
      const session = await client.create({ runId: 'cmd' });

      const result = await session.run?.({ argv: ['echo', 'hello world'] });

      expect(sandboxManager.wrapWithSandboxArgv).toHaveBeenCalledWith(
        "echo 'hello world'",
        undefined,
        expect.objectContaining({
          filesystem: expect.objectContaining({
            allowWrite: expect.arrayContaining([session.root]),
          }),
        }),
        undefined,
      );
      expect(result?.exitCode).toBe(0);
      expect(result?.stdout).toBe('sandbox-ok');
    } finally {
      await fsp.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('caps sandbox output without splitting UTF-8 characters', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-test-'));
    sandboxManager.wrapWithSandboxArgv.mockResolvedValueOnce({
      argv: [
        process.execPath,
        '-e',
        "process.stdout.write('a'.repeat(5) + '한' + 'x')",
      ],
      env: {},
    });
    try {
      const client = new AsrtSandboxClient({ baseDir, maxOutputBytes: 6 });
      const session = await client.create({ runId: 'utf8-cap' });

      const result = await session.run?.({ argv: ['echo', 'large'] });

      expect(result?.stdout).toBe('aaaaa');
      expect(result?.stdout).not.toContain('\uFFFD');
    } finally {
      await fsp.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('keeps ASRT-provided environment variables authoritative', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-test-'));
    sandboxManager.wrapWithSandboxArgv.mockResolvedValueOnce({
      argv: [process.execPath, '-e', 'process.stdout.write(process.env.HTTP_PROXY ?? "")'],
      env: { HTTP_PROXY: 'http://sandbox-proxy' },
    });
    try {
      const client = new AsrtSandboxClient({ baseDir });
      const session = await client.create({ runId: 'env' });

      const result = await session.run?.({
        argv: ['echo', 'env'],
        env: { HTTP_PROXY: 'http://caller-proxy' },
      });

      expect(result?.stdout).toBe('http://sandbox-proxy');
    } finally {
      await fsp.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('does not inherit host environment variables from ASRT process env', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-test-'));
    process.env.NEXORA_SECRET = 'super-secret';
    sandboxManager.wrapWithSandboxArgv.mockResolvedValueOnce({
      argv: [process.execPath, '-e', 'process.stdout.write(process.env.NEXORA_SECRET ?? "")'],
      env: process.env,
    });
    try {
      const client = new AsrtSandboxClient({ baseDir });
      const session = await client.create({ runId: 'no-env-leak' });

      const result = await session.run?.({
        argv: ['printenv', 'NEXORA_SECRET'],
        env: { PATH: process.env.PATH ?? '' },
      });

      expect(result?.stdout).toBe('');
    } finally {
      delete process.env.NEXORA_SECRET;
      await fsp.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('reuses a fixed root across runs when perRun is false', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const fixedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-fixed-'));
    try {
      const client = new AsrtSandboxClient({ perRun: false, root: fixedRoot, cleanup: 'keep' });

      const a = await client.create({ runId: 'turn-1' });
      const b = await client.create({ runId: 'turn-2' });

      expect(a.root).toBe(await fsp.realpath(fixedRoot));
      expect(b.root).toBe(a.root);
    } finally {
      await fsp.rm(fixedRoot, { recursive: true, force: true });
    }
  });

  it('persists files across sessions on a fixed root with cleanup keep', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const fixedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-persist-'));
    try {
      const client = new AsrtSandboxClient({ perRun: false, root: fixedRoot, cleanup: 'keep' });

      const first = await client.create({ runId: 'turn-1' });
      await fsp.writeFile(path.join(first.root, 'draft.txt'), 'hello');
      await first.cleanup();

      const second = await client.create({ runId: 'turn-2' });
      const body = await fsp.readFile(path.join(second.root, 'draft.txt'), 'utf8');
      expect(body).toBe('hello');
    } finally {
      await fsp.rm(fixedRoot, { recursive: true, force: true });
    }
  });

  it('uses baseWorkdir as the fixed root when no explicit root is set', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-base-'));
    try {
      const client = new AsrtSandboxClient({ perRun: false, cleanup: 'keep' });
      const session = await client.create({ baseWorkdir: base });
      expect(session.root).toBe(await fsp.realpath(base));
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  it('throws when perRun is false and neither root nor baseWorkdir is provided', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const client = new AsrtSandboxClient({ perRun: false });
    await expect(client.create({})).rejects.toThrow(/root, baseWorkdir, or perRun/);
  });

  it('snapshots to a backend and resumes into a fresh root after the original is gone', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const { LocalTarSnapshotBackend } = await import('../workspace-snapshot.js');
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-snap-'));
    const store = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-snapstore-'));
    try {
      const client = new AsrtSandboxClient({
        baseDir,
        snapshotBackend: new LocalTarSnapshotBackend(store),
        cleanup: 'delete',
      });

      const first = await client.create({ runId: 'conv-7' });
      await fsp.writeFile(path.join(first.root, 'memo.txt'), 'remember-me');

      const snap = await first.snapshot?.();
      expect(snap?.backend).toBe('local-tar');
      expect(snap?.ref).toBeTruthy();

      // Simulate per-run tmpdir loss between turns.
      await fsp.rm(first.root, { recursive: true, force: true });

      const resumed = await client.resume?.(snap!);
      expect(resumed).toBeDefined();
      const body = await fsp.readFile(path.join(resumed!.root, 'memo.txt'), 'utf8');
      expect(body).toBe('remember-me');
    } finally {
      await fsp.rm(baseDir, { recursive: true, force: true });
      await fsp.rm(store, { recursive: true, force: true });
    }
  });

  it('falls back to an inline-root snapshot when no backend is configured', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-inline-'));
    try {
      const client = new AsrtSandboxClient({ baseDir, cleanup: 'keep' });
      const session = await client.create({ runId: 'inline-1' });

      const snap = await session.snapshot?.();
      expect(snap?.backend).toBe('inline-root');
      expect(snap?.ref).toBeUndefined();
      expect(snap?.root).toBe(session.root);
    } finally {
      await fsp.rm(baseDir, { recursive: true, force: true });
    }
  });
});
