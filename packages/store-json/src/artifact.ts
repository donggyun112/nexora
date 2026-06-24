/**
 * ArtifactChannelJson — conversationId(scope) 키 산출물 공유 (dev 백엔드).
 *
 * 파일 구조 (ref = uuid → scope 없이 ref만으로 fetch 가능):
 *   {dataDir}/artifacts/{ref}.bin   — 바이트
 *   {dataDir}/artifacts/{ref}.json  — 메타 사이드카 (ArtifactRef, 바이트 제외)
 * 참고: transcript.ts 첨부 패턴.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ArtifactChannel,
  ArtifactRef,
  ArtifactPublishOptions,
  StoreBackendInfo,
  DescribableStore,
} from '@dongkseo/contracts';

/** ref는 uuid만 허용 — 경로 탈출 차단. */
function isSafeRef(ref: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(ref);
}

export class ArtifactChannelJson implements ArtifactChannel, DescribableStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'artifacts');
  }

  describeBackend(): StoreBackendInfo {
    return { name: 'json-file', type: 'dev', durable: true, multiProcess: false };
  }

  private binPath(ref: string): string {
    return path.join(this.dir, `${ref}.bin`);
  }

  private metaPath(ref: string): string {
    return path.join(this.dir, `${ref}.json`);
  }

  async publish(
    scope: string,
    name: string,
    bytes: Buffer,
    options?: ArtifactPublishOptions,
  ): Promise<ArtifactRef> {
    await fsp.mkdir(this.dir, { recursive: true });
    const ref = randomUUID();
    const createdAt = Date.now();
    const meta: ArtifactRef = {
      ref,
      scope,
      name,
      mediaType: options?.mediaType ?? 'application/octet-stream',
      size: bytes.length,
      createdAt,
      ...(options?.ttlMs != null ? { expiresAt: createdAt + options.ttlMs } : {}),
      ...(options?.meta !== undefined ? { meta: options.meta } : {}),
    };
    await fsp.writeFile(this.binPath(ref), bytes, { mode: 0o600 });
    await fsp.writeFile(this.metaPath(ref), JSON.stringify(meta), { mode: 0o600 });
    return meta;
  }

  async fetch(ref: string): Promise<Buffer | null> {
    if (!isSafeRef(ref)) return null;
    try {
      return await fsp.readFile(this.binPath(ref));
    } catch {
      return null;
    }
  }

  async list(scope: string): Promise<ArtifactRef[]> {
    if (!fs.existsSync(this.dir)) return [];
    const files = (await fsp.readdir(this.dir)).filter(f => f.endsWith('.json'));
    const refs: ArtifactRef[] = [];
    for (const file of files) {
      const raw = await fsp.readFile(path.join(this.dir, file), 'utf-8');
      const meta = JSON.parse(raw) as ArtifactRef;
      if (meta.scope === scope) refs.push(meta);
    }
    refs.sort((a, b) => a.createdAt - b.createdAt);
    return refs;
  }

  async delete(ref: string): Promise<void> {
    if (!isSafeRef(ref)) return;
    await fsp.rm(this.binPath(ref), { force: true });
    await fsp.rm(this.metaPath(ref), { force: true });
  }

  async cleanup(now: number = Date.now()): Promise<number> {
    if (!fs.existsSync(this.dir)) return 0;
    const files = (await fsp.readdir(this.dir)).filter(f => f.endsWith('.json'));
    let removed = 0;
    for (const file of files) {
      const raw = await fsp.readFile(path.join(this.dir, file), 'utf-8');
      const meta = JSON.parse(raw) as ArtifactRef;
      if (meta.expiresAt != null && meta.expiresAt <= now) {
        await this.delete(meta.ref);
        removed++;
      }
    }
    return removed;
  }
}
