/**
 * TranscriptStorePg — PostgreSQL-backed V2 transcript store.
 *
 * 하이브리드 스키마: 질의 축(conversation_id · channel · type · ts)은 컬럼,
 * entry 본문은 jsonb 통째. attachment 는 bytea. 채널은 분할 축이 아니라
 * 속성 — 모든 채널이 단일 테이블에 저장되고 channel 컬럼으로만 구분된다.
 */

import { randomUUID } from 'node:crypto';

import type { AttachmentRef, TranscriptEntry, TranscriptStore } from '@nexora/contracts';

import type { Sql } from './pg-client.js';

interface EntryRow {
  entry: unknown;
}

interface AttachmentDataRow {
  data: Buffer;
}

export class TranscriptStorePg implements TranscriptStore {
  constructor(private readonly sql: Sql) {}

  async appendEntry(entry: TranscriptEntry): Promise<void> {
    await this.sql`
      INSERT INTO nexora_transcript_entry (conversation_id, uuid, channel, type, ts, entry)
      VALUES (${entry.conversationId}, ${entry.uuid}, ${entry.channel ?? null},
              ${entry.type}, ${entry.timestamp}, ${this.sql.json(entry as never)})
    `;
  }

  async flush(): Promise<void> {
    // 쿼리 resolve 시점에 이미 durable — 계약 충족용 no-op.
  }

  async *getEntries(
    conversationId: string,
    opts?: { limit?: number },
  ): AsyncIterable<TranscriptEntry> {
    const limit = opts?.limit;
    let rows: EntryRow[];
    if (limit !== undefined && limit >= 0) {
      rows = (await this.sql`
        SELECT entry FROM nexora_transcript_entry
        WHERE conversation_id = ${conversationId}
        ORDER BY seq DESC LIMIT ${limit}
      `) as unknown as EntryRow[];
      rows.reverse(); // newest tail → 삽입순 복원
    } else {
      rows = (await this.sql`
        SELECT entry FROM nexora_transcript_entry
        WHERE conversation_id = ${conversationId}
        ORDER BY seq ASC
      `) as unknown as EntryRow[];
    }
    for (const row of rows) {
      yield row.entry as TranscriptEntry;
    }
  }

  async putAttachment(
    conversationId: string,
    data: Buffer,
    mediaType: string,
    name?: string,
  ): Promise<AttachmentRef> {
    const ref = randomUUID();
    await this.sql`
      INSERT INTO nexora_transcript_attachment (conversation_id, ref, media_type, size, name, data)
      VALUES (${conversationId}, ${ref}, ${mediaType}, ${data.length}, ${name ?? null}, ${data})
      ON CONFLICT (conversation_id, ref) DO UPDATE
        SET media_type = EXCLUDED.media_type, size = EXCLUDED.size,
            name = EXCLUDED.name, data = EXCLUDED.data
    `;
    return { ref, mediaType, size: data.length, ...(name !== undefined ? { name } : {}) };
  }

  async getAttachment(conversationId: string, ref: string): Promise<Buffer | null> {
    const rows = (await this.sql`
      SELECT data FROM nexora_transcript_attachment
      WHERE conversation_id = ${conversationId} AND ref = ${ref}
    `) as unknown as AttachmentDataRow[];
    return rows.length > 0 ? Buffer.from(rows[0]!.data) : null;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM nexora_transcript_entry WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM nexora_transcript_attachment WHERE conversation_id = ${conversationId}`;
    });
  }
}
