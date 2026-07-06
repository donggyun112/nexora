/**
 * DurableDirStore — overlay-rootfs backend 의 archive 매체.
 *
 * 세션 상태(workspace + overlay upper)가 이미 볼륨 위 디렉토리라 "archive" 는
 * 보존 작업이 아니라 핸들 해제다: meta 의 lastUsedAt 만 갱신하고 true 를
 * 반환하면 registry 가 entry 를 내린다. thaw 는 디렉토리 존재 확인 후
 * 재-attach. TTL sweep 이 유일한 실삭제 경로다.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceSession } from '@dongkseo/contracts';
import type { ArchiveStore } from './archive-store.js';

interface AttachableClient {
  attach(key: string): Promise<WorkspaceSession | null>;
}

export class DurableDirStore implements ArchiveStore {
  private readonly convDir: string;

  constructor(
    private readonly client: AttachableClient,
    options: { convDir: string },
  ) {
    this.convDir = path.resolve(options.convDir);
  }

  async archive(id: string, _session: WorkspaceSession, opts: { force?: boolean; stillValid: () => boolean }): Promise<boolean> {
    // 디스크가 이미 정본이라 느린 스냅샷 단계는 없지만, meta 쓰기를 await 하는 동안
    // 요청이 acquire() 해 inFlight/lastUsedAt 을 갱신할 수 있다 — TarArchiveStore 와
    // 동일하게 stillValid 를 존중해야 registry 가 살아있는 세션을 드롭하지 않는다.
    if (!opts.force && !opts.stillValid()) return false;
    await this.writeMeta(id, Date.now());
    return true;
  }

  async thaw(id: string): Promise<WorkspaceSession | null> {
    return await this.client.attach(id);
  }

  async delete(id: string): Promise<void> {
    await fsp.rm(this.sessionDir(id), { recursive: true, force: true });
  }

  async sweepStale(olderThanMs: number, liveIds: ReadonlySet<string>, now = Date.now()): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.convDir);
    } catch {
      return; // conv dir not created yet
    }
    for (const name of names) {
      const id = decodeURIComponent(name);
      if (liveIds.has(id)) continue;
      const dir = path.join(this.convDir, name);
      const lastUsedAt = await this.readMeta(dir);
      if (now - lastUsedAt > olderThanMs) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private sessionDir(id: string): string {
    const dir = path.join(this.convDir, encodeURIComponent(id));
    const relative = path.relative(this.convDir, dir);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`sessionId escapes convDir: ${id}`);
    }
    return dir;
  }

  private async writeMeta(id: string, lastUsedAt: number): Promise<void> {
    await fsp
      .writeFile(path.join(this.sessionDir(id), 'meta.json'), JSON.stringify({ lastUsedAt }))
      .catch(() => {});
  }

  private async readMeta(dir: string): Promise<number> {
    try {
      const raw = await fsp.readFile(path.join(dir, 'meta.json'), 'utf8');
      const parsed = JSON.parse(raw) as { lastUsedAt?: number };
      if (typeof parsed.lastUsedAt === 'number') return parsed.lastUsedAt;
    } catch {
      // fall through to mtime
    }
    try {
      return (await fsp.stat(dir)).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY; // 사라진 디렉토리는 건드리지 않음
    }
  }
}
