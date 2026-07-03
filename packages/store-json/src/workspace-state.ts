/**
 * WorkspaceStateStoreJson — JSON 파일.
 *
 * 파일 구조: {dataDir}/workspace-state/{conversationId}.json (한 대화 = 한 파일, 덮어쓰기)
 * 참고: suspended-turn.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  WorkspaceStateStore,
  SandboxSessionState,
  StoreBackendInfo,
  DescribableStore,
} from '@dongkseo/contracts';

export class WorkspaceStateStoreJson implements WorkspaceStateStore, DescribableStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'workspace-state');
  }

  describeBackend(): StoreBackendInfo {
    return { name: 'json-file', type: 'dev', durable: true, multiProcess: false };
  }

  private filePath(conversationId: string): string {
    return path.join(this.dir, `${conversationId}.json`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  async save(conversationId: string, state: SandboxSessionState): Promise<void> {
    this.ensureDir();
    fs.writeFileSync(this.filePath(conversationId), JSON.stringify(state, null, 2), 'utf-8');
  }

  async load(conversationId: string): Promise<SandboxSessionState | null> {
    const file = this.filePath(conversationId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as SandboxSessionState;
    } catch {
      return null;
    }
  }

  async delete(conversationId: string): Promise<void> {
    const file = this.filePath(conversationId);
    if (fs.existsSync(file)) fs.rmSync(file);
  }
}
