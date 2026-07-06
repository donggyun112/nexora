import { describe, expect, it } from 'vitest';
import type { WorkspaceSession } from '@dongkseo/contracts';
import type { ArchiveStore } from '../archive-store.js';
import { SessionRegistry } from '../session-registry.js';

function stubSession(root = '/tmp/x'): WorkspaceSession {
  return {
    id: 's',
    root,
    mode: 'workspace-write',
    mounts: [],
    resolve: async (rel) => ({ path: `${root}/${rel}`, root, relativePath: rel, access: 'ro' }),
    cleanup: async () => {},
  } as WorkspaceSession;
}

function fakeStore(overrides: Partial<ArchiveStore> = {}) {
  const calls: string[] = [];
  const store: ArchiveStore = {
    archive: async () => (calls.push('archive'), true),
    thaw: async () => (calls.push('thaw'), null),
    delete: async () => void calls.push('delete'),
    sweepStale: async () => void calls.push('sweepStale'),
    ...overrides,
  };
  return { store, calls };
}

describe('SessionRegistry × ArchiveStore', () => {
  it('idle sweep 은 store.archive 를 호출하고 성공 시 entry 를 내린다', async () => {
    const { store, calls } = fakeStore();
    const registry = new SessionRegistry(store, { idleTtlMs: 0 });
    registry.register('a', stubSession());
    await registry.sweep(Date.now() + 1);
    expect(calls).toContain('archive');
    expect(registry.acquire('a')).toBeUndefined();
  });

  it('archive 가 false(중도 활성화) 를 반환하면 세션이 live 로 남는다', async () => {
    const { store } = fakeStore({ archive: async () => false });
    const registry = new SessionRegistry(store, { idleTtlMs: 0 });
    registry.register('a', stubSession());
    await registry.sweep(Date.now() + 1);
    expect(registry.acquire('a')).toBeDefined();
  });

  it('reattach 는 miss 시 store.thaw 를 쓰고 세션을 재등록한다', async () => {
    const { store } = fakeStore({ thaw: async () => stubSession('/tmp/thawed') });
    const registry = new SessionRegistry(store, {});
    const res = await registry.reattach('gone');
    expect(res).toEqual({ alive: true, root: '/tmp/thawed' });
    expect(registry.acquire('gone')).toBeDefined();
  });

  it('destroy 는 store.delete 를 호출한다 / sweep 은 live id 집합을 sweepStale 에 넘긴다', async () => {
    const seen: ReadonlySet<string>[] = [];
    const { store, calls } = fakeStore({
      sweepStale: async (_ttl, liveIds) => void seen.push(liveIds),
    });
    const registry = new SessionRegistry(store, { idleTtlMs: 60_000 });
    registry.register('live-1', stubSession());
    await registry.destroy('other');
    await registry.sweep();
    expect(calls).toContain('delete');
    expect([...seen[0]!]).toEqual(['live-1']);
  });
});
