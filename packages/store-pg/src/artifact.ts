/**
 * ArtifactChannelPg — PostgreSQL-backed 산출물 공유 채널.
 *
 * 바이트는 bytea, 메타는 컬럼 + jsonb. ref는 globally-unique PK라
 * fetch는 scope 없이 ref만으로 조회한다. TTL은 cleanup 스윕으로 실현.
 * 참고: transcript.ts putAttachment/getAttachment (bytea 패턴).
 */

import { randomUUID } from 'node:crypto';

import type {
  ArtifactChannel,
  ArtifactRef,
  ArtifactPublishOptions,
  StoreBackendInfo,
  DescribableStore,
} from '@dongkseo/contracts';

import type { Sql } from './pg-client.js';

interface ArtifactMetaRow {
  ref: string;
  scope: string;
  name: string;
  media_type: string;
  size: string | number;
  created_at: string | number;
  expires_at: string | number | null;
  meta: Record<string, unknown> | null;
}

interface ArtifactDataRow {
  data: Buffer;
}

function rowToRef(r: ArtifactMetaRow): ArtifactRef {
  const expiresAt = r.expires_at != null ? Number(r.expires_at) : undefined;
  return {
    ref: r.ref,
    scope: r.scope,
    name: r.name,
    mediaType: r.media_type,
    size: Number(r.size),
    createdAt: Number(r.created_at),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(r.meta != null ? { meta: r.meta } : {}),
  };
}

export class ArtifactChannelPg implements ArtifactChannel, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async publish(
    scope: string,
    name: string,
    bytes: Buffer,
    options?: ArtifactPublishOptions,
  ): Promise<ArtifactRef> {
    const ref = randomUUID();
    const mediaType = options?.mediaType ?? 'application/octet-stream';
    const createdAt = Date.now();
    const expiresAt = options?.ttlMs != null ? createdAt + options.ttlMs : null;
    const meta = options?.meta ?? null;
    await this.sql`
      INSERT INTO nexora_artifacts (ref, scope, name, media_type, size, created_at, expires_at, meta, data)
      VALUES (${ref}, ${scope}, ${name}, ${mediaType}, ${bytes.length}, ${createdAt},
              ${expiresAt}, ${meta != null ? this.sql.json(meta as never) : null}, ${bytes})
    `;
    return {
      ref, scope, name, mediaType, size: bytes.length, createdAt,
      ...(expiresAt != null ? { expiresAt } : {}),
      ...(meta != null ? { meta } : {}),
    };
  }

  async fetch(ref: string): Promise<Buffer | null> {
    const rows = (await this.sql`
      SELECT data FROM nexora_artifacts WHERE ref = ${ref}
    `) as unknown as ArtifactDataRow[];
    return rows.length > 0 ? Buffer.from(rows[0]!.data) : null;
  }

  async list(scope: string): Promise<ArtifactRef[]> {
    const rows = (await this.sql`
      SELECT ref, scope, name, media_type, size, created_at, expires_at, meta
      FROM nexora_artifacts WHERE scope = ${scope}
      ORDER BY created_at ASC
    `) as unknown as ArtifactMetaRow[];
    return rows.map(rowToRef);
  }

  async delete(ref: string): Promise<void> {
    await this.sql`DELETE FROM nexora_artifacts WHERE ref = ${ref}`;
  }

  async cleanup(now: number = Date.now()): Promise<number> {
    const rows = (await this.sql`
      DELETE FROM nexora_artifacts
      WHERE expires_at IS NOT NULL AND expires_at <= ${now}
      RETURNING ref
    `) as unknown as { ref: string }[];
    return rows.length;
  }
}
