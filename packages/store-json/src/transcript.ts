/**
 * TranscriptStoreJson — V2 transcript 의 JSONL 파일 어댑터.
 *
 * 파일 구조:
 *   {dataDir}/transcripts/{conversationId}.jsonl       — append-only 본문
 *   {dataDir}/transcripts/{conversationId}.attachments/ — 첨부 바이너리 (uuid.ext)
 *
 * 쓰기 모델:
 *   - 호출당 즉시 fsync 대신 microtask 단위로 batched append.
 *   - 한 번의 drain 에서 같은 파일로 가는 여러 엔트리를 한 번에 묶어 쓰기.
 *   - MAX_CHUNK_BYTES 를 초과하면 도중에 한 번 flush 하고 새 chunk 시작.
 *   - flush() 가 durability boundary — 종료/스냅샷 시 명시 호출.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  TranscriptStore,
  TranscriptEntry,
  AttachmentRef,
  StoreBackendInfo,
  DescribableStore,
} from '@dongkseo/contracts';

const FLUSH_INTERVAL_MS = 25;
const MAX_CHUNK_BYTES = 64 * 1024;

interface QueueItem {
  entry: TranscriptEntry;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class TranscriptStoreJson implements TranscriptStore, DescribableStore {
  private readonly dir: string;
  private writeQueues = new Map<string, QueueItem[]>();
  private flushTimer: NodeJS.Timeout | null = null;
  private activeDrain: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'transcripts');
  }

  describeBackend(): StoreBackendInfo {
    return { name: 'json-file', type: 'dev', durable: true, multiProcess: false };
  }

  appendEntry(entry: TranscriptEntry): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const fp = this.filePath(entry.conversationId);
      let q = this.writeQueues.get(fp);
      if (!q) {
        q = [];
        this.writeQueues.set(fp, q);
      }
      q.push({ entry, resolve, reject });
      this.scheduleDrain();
    });
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.activeDrain || this.hasPending()) {
      if (this.activeDrain) {
        await this.activeDrain;
      } else {
        this.activeDrain = this.drainOnce();
        await this.activeDrain;
        this.activeDrain = null;
      }
    }
  }

  async *getEntries(
    conversationId: string,
    opts?: { limit?: number },
  ): AsyncGenerator<TranscriptEntry> {
    const fp = this.filePath(conversationId);
    let content: string;
    try {
      content = await fsp.readFile(fp, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const start =
      opts?.limit !== undefined && opts.limit > 0
        ? Math.max(0, lines.length - opts.limit)
        : 0;
    for (let i = start; i < lines.length; i++) {
      try {
        yield JSON.parse(lines[i]) as TranscriptEntry;
      } catch {
        // 한 줄이 깨져도 나머지 살아있게 — 라인 단위 skip.
      }
    }
  }

  async putAttachment(
    conversationId: string,
    data: Buffer,
    mediaType: string,
    name?: string,
  ): Promise<AttachmentRef> {
    const adir = this.attachmentDir(conversationId);
    await fsp.mkdir(adir, { recursive: true, mode: 0o700 });
    const ext = extensionForMime(mediaType);
    const id = randomUUID();
    const ref = `${id}.${ext}`;
    const fp = path.join(adir, ref);
    await fsp.writeFile(fp, data, { mode: 0o600 });
    return { ref, mediaType, size: data.length, name };
  }

  async getAttachment(conversationId: string, ref: string): Promise<Buffer | null> {
    if (!isSafeAttachmentRef(ref)) return null;
    const fp = path.join(this.attachmentDir(conversationId), ref);
    try {
      return await fsp.readFile(fp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.flush();
    const fp = this.filePath(conversationId);
    const adir = this.attachmentDir(conversationId);
    await Promise.all([
      fsp.unlink(fp).catch(() => {}),
      fsp.rm(adir, { recursive: true, force: true }).catch(() => {}),
    ]);
  }

  private filePath(conversationId: string): string {
    return path.join(this.dir, `${safeId(conversationId)}.jsonl`);
  }

  private attachmentDir(conversationId: string): string {
    return path.join(this.dir, `${safeId(conversationId)}.attachments`);
  }

  private hasPending(): boolean {
    for (const q of this.writeQueues.values()) {
      if (q.length > 0) return true;
    }
    return false;
  }

  private scheduleDrain(): void {
    if (this.flushTimer || this.activeDrain) return;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      this.activeDrain = this.drainOnce();
      try {
        await this.activeDrain;
      } finally {
        this.activeDrain = null;
      }
      if (this.hasPending()) this.scheduleDrain();
    }, FLUSH_INTERVAL_MS);
  }

  private async drainOnce(): Promise<void> {
    for (const [fp, queue] of this.writeQueues) {
      if (queue.length === 0) continue;
      const batch = queue.splice(0);

      let buf = '';
      const pending: QueueItem[] = [];

      const flushBuffer = async (): Promise<void> => {
        if (!buf) return;
        try {
          await this.appendToFile(fp, buf);
          for (const item of pending) item.resolve();
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          for (const item of pending) item.reject(e);
        } finally {
          buf = '';
          pending.length = 0;
        }
      };

      for (const item of batch) {
        const line = JSON.stringify(item.entry) + '\n';
        if (buf.length + line.length >= MAX_CHUNK_BYTES) {
          await flushBuffer();
        }
        buf += line;
        pending.push(item);
      }
      await flushBuffer();
    }

    for (const [fp, queue] of this.writeQueues) {
      if (queue.length === 0) this.writeQueues.delete(fp);
    }
  }

  private async appendToFile(fp: string, data: string): Promise<void> {
    try {
      await fsp.appendFile(fp, data, { mode: 0o600 });
    } catch {
      await fsp.mkdir(path.dirname(fp), { recursive: true, mode: 0o700 });
      await fsp.appendFile(fp, data, { mode: 0o600 });
    }
  }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isSafeAttachmentRef(ref: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(ref) && !ref.includes('..');
}

function extensionForMime(mt: string): string {
  const lower = mt.toLowerCase();
  switch (lower) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'text/plain':
      return 'txt';
    case 'text/markdown':
      return 'md';
    case 'application/json':
      return 'json';
    case 'application/pdf':
      return 'pdf';
    default: {
      const m = /\/([a-z0-9.+-]+)$/i.exec(lower);
      const ext = m ? m[1].replace(/[^a-z0-9]/gi, '') : '';
      return ext || 'bin';
    }
  }
}
