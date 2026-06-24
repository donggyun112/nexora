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

  it('global init path replaces config on second acquire when sandboxing already enabled', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const rootA = await fsp.mkdtemp(path.join(os.tmpdir(), 'asrt-gA-'));
    const rootB = await fsp.mkdtemp(path.join(os.tmpdir(), 'asrt-gB-'));
    try {
      const client = new AsrtSandboxClient({ perRun: false, cleanup: 'keep' });
      sandboxManager.isSandboxingEnabled.mockReturnValue(true); // 이미 활성 가정
      await client.create({ baseWorkdir: rootA });
      await client.create({ baseWorkdir: rootB });

      // 두 번째 acquire는 updateConfig로 전역 config를 B 기준으로 교체한다(전역 상태 공유 입증).
      expect(sandboxManager.updateConfig).toHaveBeenCalledTimes(2);
      const lastCfg = sandboxManager.updateConfig.mock.calls.at(-1)?.[0];
      expect(lastCfg.filesystem.allowWrite).toContain(await fsp.realpath(rootB));
    } finally {
      sandboxManager.isSandboxingEnabled.mockReturnValue(false);
      await fsp.rm(rootA, { recursive: true, force: true });
      await fsp.rm(rootB, { recursive: true, force: true });
    }
  });
});
