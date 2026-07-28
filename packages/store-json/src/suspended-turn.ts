/**
 * SuspendedTurnStoreJson — JSON 파일.
 *
 * 파일 구조: {dataDir}/suspended-turns/{pendingId}.json (한 turn = 한 파일)
 * 참고: schedule.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SuspendedTurnStore, SuspendedTurnState, StoreBackendInfo, DescribableStore } from '@dongkseo/contracts';

export class SuspendedTurnStoreJson implements SuspendedTurnStore, DescribableStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'suspended-turns');
  }

  describeBackend(): StoreBackendInfo {
    return { name: 'json-file', type: 'dev', durable: true, multiProcess: false };
  }

  private filePath(pendingId: string): string {
    return path.join(this.dir, `${pendingId}.json`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  async save(state: SuspendedTurnState): Promise<void> {
    this.ensureDir();
    fs.writeFileSync(this.filePath(state.pendingId), JSON.stringify(state, null, 2), 'utf-8');
  }

  async claim(pendingId: string): Promise<SuspendedTurnState | null> {
    const file = this.filePath(pendingId);
    if (!fs.existsSync(file)) return null;
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf-8')) as SuspendedTurnState;
      if (state.status !== 'awaiting') return null;
      const claimed: SuspendedTurnState = { ...state, status: 'resumed' };
      fs.writeFileSync(file, JSON.stringify(claimed, null, 2), 'utf-8');
      return claimed;
    } catch {
      return null;
    }
  }

  async release(pendingId: string): Promise<boolean> {
    const file = this.filePath(pendingId);
    if (!fs.existsSync(file)) return false;
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf-8')) as SuspendedTurnState;
      if (state.status !== 'resumed') return false;
      fs.writeFileSync(file, JSON.stringify({ ...state, status: 'awaiting' }, null, 2), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  async load(pendingId: string): Promise<SuspendedTurnState | null> {
    const file = this.filePath(pendingId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as SuspendedTurnState;
    } catch {
      return null;
    }
  }

  async delete(pendingId: string): Promise<void> {
    const file = this.filePath(pendingId);
    if (fs.existsSync(file)) fs.rmSync(file);
  }

  async listAwaiting(): Promise<SuspendedTurnState[]> {
    if (!fs.existsSync(this.dir)) return [];
    const out: SuspendedTurnState[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const state = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf-8')) as SuspendedTurnState;
        if (state.status === 'awaiting') out.push(state);
      } catch {
        // skip corrupt entries
      }
    }
    return out;
  }
}
