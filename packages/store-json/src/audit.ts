/**
 * AuditStoreJson — JSONL append 패턴.
 *
 * 파일 구조: {dataDir}/audit/{namespace}.jsonl
 * 각 라인: JSON 직렬화된 AuditEntry
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AuditStore, AuditEntry, AuditFilter, StoreBackendInfo, DescribableStore } from '@nexora/contracts';

export class AuditStoreJson implements AuditStore, DescribableStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'audit');
  }

  describeBackend(): StoreBackendInfo {
    return { name: 'json-file', type: 'dev', durable: true, multiProcess: false };
  }

  private filePath(namespace: string): string {
    return path.join(this.dir, `${namespace}.jsonl`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  async record(namespace: string, entry: AuditEntry): Promise<void> {
    this.ensureDir();
    fs.appendFileSync(this.filePath(namespace), JSON.stringify(entry) + '\n', 'utf-8');
  }

  async query(namespace: string, filter?: AuditFilter): Promise<AuditEntry[]> {
    const file = this.filePath(namespace);
    if (!fs.existsSync(file)) return [];

    const content = await fsp.readFile(file, 'utf-8');
    let entries: AuditEntry[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      entries.push(JSON.parse(line) as AuditEntry);
    }

    if (filter?.type) {
      entries = entries.filter(e => e.type === filter.type);
    }
    if (filter?.since) {
      entries = entries.filter(e => e.timestamp >= filter.since!);
    }
    if (filter?.limit) {
      entries = entries.slice(-filter.limit);
    }

    return entries;
  }
}
