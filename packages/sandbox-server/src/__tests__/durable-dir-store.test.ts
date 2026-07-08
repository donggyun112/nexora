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

  it('archive 는 stillValid 가 false 이고 force 도 아니면 false 를 반환하고 meta 를 쓰지 않는다', async () => {
    const { client, store, convDir } = await setup();
    const session = await client.create({ metadata: { sessionKey: 'race' } });
    const metaPath = path.join(convDir, 'race', 'meta.json');
    const before = JSON.parse(await fsp.readFile(metaPath, 'utf8')) as { lastUsedAt: number };
    const ok = await store.archive('race', session, { stillValid: () => false });
    expect(ok).toBe(false);
    const after = JSON.parse(await fsp.readFile(metaPath, 'utf8')) as { lastUsedAt: number };
    expect(after.lastUsedAt).toBe(before.lastUsedAt);
  });

  it('archive 는 force 면 stillValid 가 false 여도 meta 를 쓰고 true 를 반환한다', async () => {
    const { client, store, convDir } = await setup();
    const session = await client.create({ metadata: { sessionKey: 'forced' } });
    const ok = await store.archive('forced', session, { force: true, stillValid: () => false });
    expect(ok).toBe(true);
    await expect(fsp.stat(path.join(convDir, 'forced', 'meta.json'))).resolves.toBeTruthy();
  });

  it('thaw 는 기존 디렉토리에 재-attach, 없으면 null', async () => {
    const { client, store, convDir } = await setup();
    await client.create({ metadata: { sessionKey: 'b' } });
    const revived = await store.thaw('b');
    expect(revived?.root).toBe('/home/agent');
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

  it('delete("..")는 탈출 시도를 reject 하고 parent dir 을 건드리지 않음', async () => {
    const { store, convDir } = await setup();
    const parentDir = path.dirname(convDir);
    const parentStatBefore = await fsp.stat(parentDir);
    await expect(store.delete('..')).rejects.toThrow(/escapes convDir/);
    const parentStatAfter = await fsp.stat(parentDir);
    // parent 디렉토리는 그대로 (mtime 은 약간 차이날 수 있으니 존재만 확인)
    expect(parentStatAfter.isDirectory()).toBe(true);
  });

  it('archive("..")는 탈출 시도를 reject 하고 parent dir meta 를 건드리지 않음', async () => {
    const { client, store, convDir } = await setup();
    const parentDir = path.dirname(convDir);
    const testSession = await client.create({ metadata: { sessionKey: 'test' } });
    await expect(store.archive('..', testSession, { stillValid: () => true })).rejects.toThrow(
      /escapes convDir/,
    );
    // parent 디렉토리에 meta.json 이 생기지 않았는지 확인
    await expect(fsp.stat(path.join(parentDir, 'meta.json'))).rejects.toThrow();
  });

  it('일반 id 는 여전히 작동한다', async () => {
    const { client, store, convDir } = await setup();
    await client.create({ metadata: { sessionKey: 'normal' } });
    const revived = await store.thaw('normal');
    expect(revived?.root).toBe('/home/agent');
  });

  it('readMeta 는 corrupt meta.json 을 mtime fallback 으로 처리한다', async () => {
    const { client, store, convDir } = await setup();
    const id = 'corrupt-meta';
    await client.create({ metadata: { sessionKey: id } });
    const sessionDirPath = path.join(convDir, id);
    // meta.json 을 corrupt 데이터로 덮어쓴다
    await fsp.writeFile(path.join(sessionDirPath, 'meta.json'), '{not json');
    // sweepStale 을 짧은 TTL 로 실행 — mtime 이 최근이므로 지워지면 안 됨
    const now = Date.now();
    await store.sweepStale(50_000, new Set());
    // 디렉토리가 여전히 존재 (mtime 이 fresh 라서 TTL 충돌 안 함)
    await expect(fsp.stat(sessionDirPath)).resolves.toBeTruthy();
    // 이제 과거 mtime 으로 수동 설정해서 TTL 초과하게 만들고 다시 sweep
    const oldTime = now - 100_000;
    await fsp.utimes(sessionDirPath, oldTime / 1000, oldTime / 1000);
    await store.sweepStale(50_000, new Set());
    // 이제 지워져야 함 (corrupt meta.json 이지만 mtime fallback 으로 충분함)
    await expect(fsp.stat(sessionDirPath)).rejects.toThrow();
  });
});
