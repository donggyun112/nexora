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

describe('createSandboxProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies the open-but-secret-safe policy to the run config', async () => {
    const { createSandboxProvider, SANDBOX_SECRET_DENYLIST } = await import('../sandbox-provider.js');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-sbp-pol-'));
    try {
      const provider = createSandboxProvider({ allowedDomains: ['registry.npmjs.org'] });
      const session = await provider.acquire({ baseWorkdir: base });
      await session.run?.({ argv: ['echo', 'hi'] });

      const cfg = sandboxManager.wrapWithSandboxArgv.mock.calls[0]![2] as {
        filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[] };
        network: { allowedDomains: string[] };
      };
      // 비밀 경로는 전부 차단되고, 읽기는 root 포함 넓게 열린다.
      for (const secret of SANDBOX_SECRET_DENYLIST) {
        expect(cfg.filesystem.denyRead).toContain(secret);
      }
      expect(cfg.filesystem.allowRead).toContain(session.root);
      expect(cfg.filesystem.allowWrite).toContain(session.root);
      // 네트워크는 소비자 allowlist만 허용.
      expect(cfg.network.allowedDomains).toEqual(['registry.npmjs.org']);
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  it('merges consumer denyRead onto the secret denylist (cannot un-deny secrets)', async () => {
    const { createSandboxProvider, SANDBOX_SECRET_DENYLIST } = await import('../sandbox-provider.js');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-sbp-merge-'));
    try {
      const provider = createSandboxProvider({ denyRead: ['/custom/secret'] });
      const session = await provider.acquire({ baseWorkdir: base });
      await session.run?.({ argv: ['echo', 'hi'] });
      const cfg = sandboxManager.wrapWithSandboxArgv.mock.calls[0]![2] as {
        filesystem: { denyRead: string[] };
      };
      expect(cfg.filesystem.denyRead).toContain('/custom/secret');
      expect(cfg.filesystem.denyRead).toContain(SANDBOX_SECRET_DENYLIST[0]);
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  it('defaults to network-blocked (empty allowlist)', async () => {
    const { createSandboxProvider } = await import('../sandbox-provider.js');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-sbp-net-'));
    try {
      const provider = createSandboxProvider();
      const session = await provider.acquire({ baseWorkdir: base });
      await session.run?.({ argv: ['echo', 'hi'] });
      const cfg = sandboxManager.wrapWithSandboxArgv.mock.calls[0]![2] as {
        network: { allowedDomains: string[] };
      };
      expect(cfg.network.allowedDomains).toEqual([]);
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  it('persists across runs by default (perRun false, same baseWorkdir reuses root)', async () => {
    const { createSandboxProvider } = await import('../sandbox-provider.js');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-sbp-persist-'));
    try {
      const provider = createSandboxProvider();
      const a = await provider.acquire({ baseWorkdir: base });
      await fsp.writeFile(path.join(a.root, 'memo.txt'), 'keep');
      await a.cleanup(); // cleanup:'keep' → root 보존

      const b = await provider.acquire({ baseWorkdir: base });
      expect(b.root).toBe(a.root);
      expect(await fsp.readFile(path.join(b.root, 'memo.txt'), 'utf8')).toBe('keep');
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });
});
