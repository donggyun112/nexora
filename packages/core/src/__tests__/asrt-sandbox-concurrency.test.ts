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
    argv: [process.execPath, '-e', 'process.stdout.write("ok")'],
    env: process.env,
  })),
  cleanupAfterCommand: vi.fn(() => {}),
}));

vi.mock('@anthropic-ai/sandbox-runtime', () => ({ SandboxManager: sandboxManager }));

describe('AsrtSandboxClient concurrency characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('per-command run() carries each session own filesystem config (isolated per command)', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const rootA = await fsp.mkdtemp(path.join(os.tmpdir(), 'asrt-concA-'));
    const rootB = await fsp.mkdtemp(path.join(os.tmpdir(), 'asrt-concB-'));
    try {
      const client = new AsrtSandboxClient({ perRun: false, cleanup: 'keep' });
      const a = await client.create({ baseWorkdir: rootA });
      const b = await client.create({ baseWorkdir: rootB });

      await a.run?.({ argv: ['echo', 'a'] });
      await b.run?.({ argv: ['echo', 'b'] });

      const calls = sandboxManager.wrapWithSandboxArgv.mock.calls;
      const cfgA = calls[0][2];
      const cfgB = calls[1][2];
      // FS 정책은 명령마다 그 세션 root를 담아 전달된다 → per-command 격리됨.
      expect(cfgA.filesystem.allowWrite).toContain(a.root);
      expect(cfgB.filesystem.allowWrite).toContain(b.root);
      expect(cfgA.filesystem.allowWrite).not.toContain(b.root);
    } finally {
      await fsp.rm(rootA, { recursive: true, force: true });
      await fsp.rm(rootB, { recursive: true, force: true });
    }
  });

  it('first acquire initializes; second acquire re-enters via updateConfig (global config swap)', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const rootA = await fsp.mkdtemp(path.join(os.tmpdir(), 'asrt-gA-'));
    const rootB = await fsp.mkdtemp(path.join(os.tmpdir(), 'asrt-gB-'));
    try {
      const client = new AsrtSandboxClient({ perRun: false, cleanup: 'keep' });

      // First acquire: sandboxing not yet enabled → initialize() path, no updateConfig.
      sandboxManager.isSandboxingEnabled.mockReturnValue(false);
      await client.create({ baseWorkdir: rootA });
      expect(sandboxManager.initialize).toHaveBeenCalledTimes(1);
      expect(sandboxManager.updateConfig).not.toHaveBeenCalled();

      // initialize() enables sandboxing; model that state for the second acquire.
      sandboxManager.isSandboxingEnabled.mockReturnValue(true);
      await client.create({ baseWorkdir: rootB });

      // Re-entry swaps the global config to B in place (no re-initialize) → global state shared.
      expect(sandboxManager.initialize).toHaveBeenCalledTimes(1);
      expect(sandboxManager.updateConfig).toHaveBeenCalledTimes(1);
      const swapped = sandboxManager.updateConfig.mock.calls.at(-1)?.[0];
      expect(swapped.filesystem.allowWrite).toContain(await fsp.realpath(rootB));
    } finally {
      sandboxManager.isSandboxingEnabled.mockReturnValue(false);
      await fsp.rm(rootA, { recursive: true, force: true });
      await fsp.rm(rootB, { recursive: true, force: true });
    }
  });
});
