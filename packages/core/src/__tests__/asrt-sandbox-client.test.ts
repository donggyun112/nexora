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
});
