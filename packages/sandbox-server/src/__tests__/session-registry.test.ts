import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxClient, WorkspaceSession } from '@dongkseo/contracts';
import { SessionRegistry } from '../session-registry.js';

async function makeSession(overrides: Partial<WorkspaceSession> = {}): Promise<WorkspaceSession> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'reg-test-'));
  await fsp.writeFile(path.join(root, 'a.txt'), 'x');
  return {
    id: crypto.randomUUID(),
    root,
    mode: 'workspace-write',
    mounts: [],
    async resolve() {
      throw new Error('not used');
    },
    async run() {
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    },
    async cleanup() {
      await fsp.rm(root, { recursive: true, force: true });
    },
    ...overrides,
  };
}

const fakeClient: SandboxClient = {
  create: () => makeSession(),
};

const dirs: string[] = [];
async function makeArchiveDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'reg-arch-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

describe('SessionRegistry concurrency', () => {
  it('aborts an in-progress archive when a request acquires during the tar write', async () => {
    const archiveDir = await makeArchiveDir();
    const registry = new SessionRegistry(fakeClient, { archiveDir, idleTtlMs: 1 });
    const session = await makeSession();
    registry.register('s1', session);

    // Start the sweep (it suspends inside writeTar), then acquire before it resumes.
    const sweeping = registry.sweep(Date.now() + 60_000);
    const acquired = registry.acquire('s1');
    expect(acquired).toBe(session);
    await sweeping;

    // The session must still be live with its root intact, and no stale tar left behind.
    expect(registry.acquire('s1')).toBe(session);
    await expect(fsp.stat(session.root)).resolves.toBeDefined();
    await expect(fsp.stat(path.join(archiveDir, 's1.tar'))).rejects.toThrow();
    await session.cleanup();
  });

  it('waits for in-flight requests before archiving on shutdown', async () => {
    const archiveDir = await makeArchiveDir();
    const registry = new SessionRegistry(fakeClient, { archiveDir });
    const session = await makeSession();
    registry.register('s1', session);
    registry.acquire('s1');

    const shuttingDown = registry.archiveAll();
    setTimeout(() => registry.release('s1'), 150);
    await shuttingDown;

    const stat = await fsp.stat(path.join(archiveDir, 's1.tar'));
    expect(stat.size).toBeGreaterThan(0);
    await expect(fsp.stat(session.root)).rejects.toThrow();
  });

  it('archives successfully even when workspace cleanup fails afterwards', async () => {
    const archiveDir = await makeArchiveDir();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new SessionRegistry(fakeClient, { archiveDir, idleTtlMs: 1 });
    const session = await makeSession({
      async cleanup() {
        throw new Error('EBUSY');
      },
    });
    registry.register('s1', session);

    await registry.sweep(Date.now() + 60_000);

    // Archive persisted, entry gone — the failure must surface as a cleanup warning,
    // not as "archive failed (kept live)".
    await expect(fsp.stat(path.join(archiveDir, 's1.tar'))).resolves.toBeDefined();
    expect(registry.acquire('s1')).toBeUndefined();
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('workspace cleanup failed after archive'))).toBe(true);
    expect(messages.some((m) => m.includes('kept live'))).toBe(false);
    await fsp.rm(session.root, { recursive: true, force: true });
  });
});
