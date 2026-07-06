import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OverlayRootfsSandboxClient } from '../overlay-rootfs-client.js';
import { DurableDirStore } from '../durable-dir-store.js';

async function setup() {
  const convDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'durable-'));
  const client = new OverlayRootfsSandboxClient({ convDir, systemDirs: ['usr'] });
  const store = new DurableDirStore(client, { convDir });
  return { convDir, client, store };
}

describe('DurableDirStore', () => {
  it('archive 는 디스크를 건드리지 않고 true (durable) — meta 만 갱신', async () => {
    const { client, store, convDir } = await setup();
    const session = await client.create({ metadata: { sessionKey: 'a' } });
    const ok = await store.archive('a', session, { stillValid: () => true });
    expect(ok).toBe(true);
    await expect(fsp.stat(path.join(convDir, 'a', 'workspace'))).resolves.toBeTruthy();
  });

  it('thaw 는 기존 디렉토리에 재-attach, 없으면 null', async () => {
    const { client, store, convDir } = await setup();
    await client.create({ metadata: { sessionKey: 'b' } });
    const revived = await store.thaw('b');
    expect(revived?.root).toBe(path.join(convDir, 'b', 'workspace'));
    expect(await store.thaw('missing')).toBeNull();
  });

  it('delete 는 conv 디렉토리를 제거한다', async () => {
    const { client, store, convDir } = await setup();
    await client.create({ metadata: { sessionKey: 'c' } });
    await store.delete('c');
    await expect(fsp.stat(path.join(convDir, 'c'))).rejects.toThrow();
  });

  it('sweepStale 은 TTL 지난 디렉토리만 지우고 live id 는 남긴다', async () => {
    const { client, store, convDir } = await setup();
    await client.create({ metadata: { sessionKey: 'old' } });
    await client.create({ metadata: { sessionKey: 'live-old' } });
    const past = JSON.stringify({ lastUsedAt: Date.now() - 100_000 });
    await fsp.writeFile(path.join(convDir, 'old', 'meta.json'), past);
    await fsp.writeFile(path.join(convDir, 'live-old', 'meta.json'), past);
    await store.sweepStale(50_000, new Set(['live-old']));
    await expect(fsp.stat(path.join(convDir, 'old'))).rejects.toThrow();
    await expect(fsp.stat(path.join(convDir, 'live-old'))).resolves.toBeTruthy();
  });
});
