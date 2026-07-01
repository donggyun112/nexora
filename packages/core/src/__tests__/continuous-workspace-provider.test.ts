import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceSession,
  WorkspaceSnapshot,
  WorkspaceStateStore,
} from '@dongkseo/contracts';
import { ContinuousWorkspaceProvider } from '../continuous-workspace-provider.js';

const sandboxManager = vi.hoisted(() => ({
  isSupportedPlatform: vi.fn(() => true),
  isSandboxingEnabled: vi.fn(() => false),
  initialize: vi.fn(async () => {}),
  updateConfig: vi.fn(() => {}),
  wrapWithSandboxArgv: vi.fn(async () => ({ argv: ['true'], env: process.env })),
  cleanupAfterCommand: vi.fn(() => {}),
}));
vi.mock('@anthropic-ai/sandbox-runtime', () => ({ SandboxManager: sandboxManager }));

function makeStore(initial: WorkspaceSnapshot | null = null): WorkspaceStateStore & {
  saved: WorkspaceSnapshot[];
} {
  let current = initial;
  const saved: WorkspaceSnapshot[] = [];
  return {
    saved,
    async load() {
      return current;
    },
    async save(_id, snap) {
      current = snap;
      saved.push(snap);
    },
    async delete() {
      current = null;
    },
  };
}

function makeSession(id: string, snap?: WorkspaceSnapshot): WorkspaceSession & {
  cleaned: boolean;
} {
  const session = {
    id,
    root: `/work/${id}`,
    mode: 'workspace-write' as const,
    mounts: [],
    cleaned: false,
    async resolve() {
      throw new Error('not used');
    },
    async snapshot() {
      return snap ?? ({ id, backend: 'inline-root', root: `/work/${id}` } as WorkspaceSnapshot);
    },
    async cleanup() {
      session.cleaned = true;
    },
  };
  return session;
}

describe('ContinuousWorkspaceProvider', () => {
  it('acquires fresh when no prior snapshot exists', async () => {
    const store = makeStore(null);
    const inner = {
      acquire: vi.fn(async () => makeSession('fresh')),
      resume: vi.fn(async () => makeSession('resumed')),
    };
    const provider = new ContinuousWorkspaceProvider(inner, store, 'conv-1');

    const session = await provider.acquire();
    expect(inner.acquire).toHaveBeenCalledTimes(1);
    expect(inner.resume).not.toHaveBeenCalled();
    expect(session.id).toBe('fresh');
  });

  it('resumes from the prior snapshot on a later turn', async () => {
    const prior: WorkspaceSnapshot = { id: 's1', backend: 'local-tar', ref: 'r1', root: '/work/s1' };
    const store = makeStore(prior);
    const inner = {
      acquire: vi.fn(async () => makeSession('fresh')),
      resume: vi.fn(async () => makeSession('resumed')),
    };
    const provider = new ContinuousWorkspaceProvider(inner, store, 'conv-1');

    await provider.acquire();
    expect(inner.resume).toHaveBeenCalledWith(prior, {});
    expect(inner.acquire).not.toHaveBeenCalled();
  });

  it('snapshots and persists on cleanup', async () => {
    const store = makeStore(null);
    const snap: WorkspaceSnapshot = { id: 'snap-1', backend: 'local-tar', ref: 'r', root: '/work' };
    const inner = {
      acquire: vi.fn(async () => makeSession('fresh', snap)),
      resume: vi.fn(async () => makeSession('resumed')),
    };
    const provider = new ContinuousWorkspaceProvider(inner, store, 'conv-1');

    const session = await provider.acquire();
    await session.cleanup();
    expect(store.saved).toEqual([snap]);
  });

  it('does not throw from cleanup when snapshot fails (best-effort)', async () => {
    const store = makeStore(null);
    const session = makeSession('fresh');
    session.snapshot = vi.fn(async () => {
      throw new Error('disk full');
    });
    const inner = {
      acquire: vi.fn(async () => session),
      resume: vi.fn(async () => makeSession('resumed')),
    };
    const provider = new ContinuousWorkspaceProvider(inner, store, 'conv-1');

    const wrapped = await provider.acquire();
    await expect(wrapped.cleanup()).resolves.toBeUndefined();
    expect(store.saved).toEqual([]);
    expect((session as unknown as { cleaned: boolean }).cleaned).toBe(true);
  });

  it('falls back to fresh acquire when resume throws (corrupt state)', async () => {
    const prior: WorkspaceSnapshot = { id: 's1', backend: 'local-tar', ref: 'bad', root: '/gone' };
    const store = makeStore(prior);
    const inner = {
      acquire: vi.fn(async () => makeSession('fresh')),
      resume: vi.fn(async () => {
        throw new Error('cannot restore');
      }),
    };
    const provider = new ContinuousWorkspaceProvider(inner, store, 'conv-1');

    const session = await provider.acquire();
    expect(inner.resume).toHaveBeenCalledTimes(1);
    expect(inner.acquire).toHaveBeenCalledTimes(1);
    expect(session.id).toBe('fresh');
  });

  it('falls back to fresh acquire when store.load throws (store unavailable)', async () => {
    const store: WorkspaceStateStore = {
      load: vi.fn(async () => { throw new Error('store unavailable'); }),
      save: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const inner = {
      acquire: vi.fn(async () => makeSession('fresh')),
      resume: vi.fn(async () => makeSession('resumed')),
    };
    const provider = new ContinuousWorkspaceProvider(inner, store, 'conv-1');

    const session = await provider.acquire();
    expect(inner.acquire).toHaveBeenCalledTimes(1);
    expect(inner.resume).not.toHaveBeenCalled();
    expect(session.id).toBe('fresh');
  });

  it('passes options (including seedDirs) through to resume', async () => {
    const prior: WorkspaceSnapshot = { id: 's1', backend: 'local-tar', ref: 'r1', root: '/work/s1' };
    const store = makeStore(prior);
    const inner = {
      acquire: vi.fn(async () => makeSession('fresh')),
      resume: vi.fn(async () => makeSession('resumed')),
    };
    const provider = new ContinuousWorkspaceProvider(inner, store, 'conv-1');

    const seedDirs = [{ source: '/tmp/x', destSubpath: '.skill_refs' }];
    await provider.acquire({ seedDirs });

    expect(inner.resume).toHaveBeenCalledWith(prior, { seedDirs });
  });
});

describe('ContinuousWorkspaceProvider end-to-end (real client + tar)', () => {
  it('carries a file from turn 1 into turn 2 after the original root is gone (cold path)', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const { LocalTarSnapshotBackend } = await import('../workspace-snapshot.js');

    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-cont-data-'));
    const snapDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-cont-snaps-'));
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-cont-base-'));

    // In-test fake store (avoids cross-package dependency on @dongkseo/store-json)
    const store = makeStore(null);

    try {
      const backend = new LocalTarSnapshotBackend(snapDir);
      // perRun:true → each turn gets a fresh root → forces snapshot/restore (cold path)
      const client = new AsrtSandboxClient({ perRun: true, baseDir, snapshotBackend: backend });

      // Turn 1
      const p1 = new ContinuousWorkspaceProvider(client, store, 'conv-e2e');
      const s1 = await p1.acquire();
      await fsp.writeFile(path.join(s1.root, 'note.txt'), 'turn-1-data');
      await s1.cleanup(); // snapshot + persist

      // Delete turn 1's root to simulate tmpdir loss
      await fsp.rm(s1.root, { recursive: true, force: true });

      // Turn 2 — same conversationId
      const p2 = new ContinuousWorkspaceProvider(client, store, 'conv-e2e');
      const s2 = await p2.acquire();
      const restored = await fsp.readFile(path.join(s2.root, 'note.txt'), 'utf8');
      expect(restored).toBe('turn-1-data');
      await s2.cleanup();
    } finally {
      await Promise.all([
        fsp.rm(dataDir, { recursive: true, force: true }),
        fsp.rm(snapDir, { recursive: true, force: true }),
        fsp.rm(baseDir, { recursive: true, force: true }),
      ]);
    }
  });
});
