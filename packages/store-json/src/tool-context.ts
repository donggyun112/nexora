/**
 * ToolContextStoreJson — JSONL + cleanup.
 *
 * 파일 구조: {dataDir}/tool-context/{scope}/{turnId}.jsonl
 * 참고: tool-context-store.ts
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ToolContextStore,
  ToolCallRecord,
  ToolResultRecord,
  ToolContextRecord,
} from '@nexora/contracts';

export class ToolContextStoreJson implements ToolContextStore {
  private readonly baseDir: string;

  constructor(dataDir: string) {
    this.baseDir = path.join(dataDir, 'tool-context');
  }

  private turnFile(scope: string, turnId: string): string {
    return path.join(this.baseDir, scope, `${turnId}.jsonl`);
  }

  private ensureScopeDir(scope: string): void {
    const dir = path.join(this.baseDir, scope);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async recordCall(scope: string, turnId: string, call: ToolCallRecord): Promise<void> {
    this.ensureScopeDir(scope);
    const entry: ToolContextRecord = { type: 'call', ...call };
    fs.appendFileSync(this.turnFile(scope, turnId), JSON.stringify(entry) + '\n', 'utf-8');
  }

  async recordResult(scope: string, turnId: string, result: ToolResultRecord): Promise<void> {
    this.ensureScopeDir(scope);
    const entry: ToolContextRecord = { type: 'result', ...result };
    fs.appendFileSync(this.turnFile(scope, turnId), JSON.stringify(entry) + '\n', 'utf-8');
  }

  async loadContext(scope: string, turnId: string): Promise<ToolContextRecord[]> {
    const file = this.turnFile(scope, turnId);
    if (!fs.existsSync(file)) return [];

    const content = await fsp.readFile(file, 'utf-8');
    const records: ToolContextRecord[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      records.push(JSON.parse(line) as ToolContextRecord);
    }
    return records;
  }

  async cleanup(retentionDays: number): Promise<number> {
    if (!fs.existsSync(this.baseDir)) return 0;

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;

    for (const scopeDir of await fsp.readdir(this.baseDir)) {
      const scopePath = path.join(this.baseDir, scopeDir);
      const stat = await fsp.stat(scopePath);
      if (!stat.isDirectory()) continue;

      for (const file of await fsp.readdir(scopePath)) {
        const filePath = path.join(scopePath, file);
        const fileStat = await fsp.stat(filePath);
        if (fileStat.mtimeMs < cutoff) {
          await fsp.unlink(filePath);
          deletedCount++;
        }
      }

      const remaining = await fsp.readdir(scopePath);
      if (remaining.length === 0) {
        await fsp.rmdir(scopePath);
      }
    }

    return deletedCount;
  }
}
