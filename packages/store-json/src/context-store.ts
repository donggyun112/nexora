/**
 * ContextStoreJson — JSON 파일.
 *
 * 파일 구조: {dataDir}/context/{namespace}/{date}.json
 * 참고: daily-context.ts
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ContextStore, DailyContext } from '@nexora/contracts';

export class ContextStoreJson implements ContextStore {
  private readonly baseDir: string;

  constructor(dataDir: string) {
    this.baseDir = path.join(dataDir, 'context');
  }

  private filePath(namespace: string, date: string): string {
    return path.join(this.baseDir, namespace, `${date}.json`);
  }

  private ensureDir(namespace: string): void {
    const dir = path.join(this.baseDir, namespace);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async saveDailyContext(namespace: string, date: string, ctx: DailyContext): Promise<void> {
    this.ensureDir(namespace);
    await fsp.writeFile(this.filePath(namespace, date), JSON.stringify(ctx, null, 2), 'utf-8');
  }

  async getDailyContext(namespace: string, date: string): Promise<DailyContext | null> {
    const file = this.filePath(namespace, date);
    if (!fs.existsSync(file)) return null;
    const content = await fsp.readFile(file, 'utf-8');
    return JSON.parse(content) as DailyContext;
  }
}
