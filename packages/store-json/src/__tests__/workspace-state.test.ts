import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSessionState } from '@dongkseo/contracts';
import { WorkspaceStateStoreJson } from '../workspace-state.js';

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-wsstate-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

const state = (id: string): SandboxSessionState => ({
  backend: 'asrt',
  snapshot: {
    id,
    backend: 'local-tar',
    ref: `/snaps/${id}.tar`,
    root: `/work/${id}`,
    fingerprint: `fp-${id}`,
  },
});

describe('WorkspaceStateStoreJson', () => {
  it('round-trips save/load by conversationId', async () => {
    const store = new WorkspaceStateStoreJson(await mkTmp());
    await store.save('conv-1', state('s1'));
    expect(await store.load('conv-1')).toEqual(state('s1'));
  });

  it('returns null for an unknown conversation', async () => {
    const store = new WorkspaceStateStoreJson(await mkTmp());
    expect(await store.load('missing')).toBeNull();
  });

  it('overwrites — keeps only the latest state', async () => {
    const store = new WorkspaceStateStoreJson(await mkTmp());
    await store.save('conv-1', state('old'));
    await store.save('conv-1', state('new'));
    expect((await store.load('conv-1'))?.snapshot?.id).toBe('new');
  });

  it('delete removes the record', async () => {
    const store = new WorkspaceStateStoreJson(await mkTmp());
    await store.save('conv-1', state('s1'));
    await store.delete('conv-1');
    expect(await store.load('conv-1')).toBeNull();
  });

  it('describes a dev backend', () => {
    const store = new WorkspaceStateStoreJson('/tmp/x');
    expect(store.describeBackend().type).toBe('dev');
  });
});
