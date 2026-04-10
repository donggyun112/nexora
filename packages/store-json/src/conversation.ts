/**
 * ConversationStoreJson — JSONL append 패턴.
 *
 * 파일 구조: {dataDir}/conversations/{conversationId}.jsonl
 * 각 라인: JSON 직렬화된 ChatMessage
 * 압축 요약: {dataDir}/conversations/{conversationId}.summary.txt
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ConversationStore, ChatMessage } from '@nexora/contracts';

export class ConversationStoreJson implements ConversationStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'conversations');
  }

  private filePath(conversationId: string): string {
    return path.join(this.dir, `${conversationId}.jsonl`);
  }

  private summaryPath(conversationId: string): string {
    return path.join(this.dir, `${conversationId}.summary.txt`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  async getHistory(conversationId: string, limit?: number): Promise<ChatMessage[]> {
    const file = this.filePath(conversationId);
    if (!fs.existsSync(file)) return [];

    const content = await fsp.readFile(file, 'utf-8');
    const messages: ChatMessage[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      messages.push(JSON.parse(line) as ChatMessage);
    }

    if (limit !== undefined && limit > 0) {
      return messages.slice(-limit);
    }
    return messages;
  }

  async appendMessage(conversationId: string, message: ChatMessage): Promise<void> {
    this.ensureDir();
    fs.appendFileSync(this.filePath(conversationId), JSON.stringify(message) + '\n', 'utf-8');
  }

  async saveCompaction(conversationId: string, summary: string): Promise<void> {
    this.ensureDir();
    await fsp.writeFile(this.summaryPath(conversationId), summary, 'utf-8');
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const file = this.filePath(conversationId);
    const summaryFile = this.summaryPath(conversationId);
    if (fs.existsSync(file)) await fsp.unlink(file);
    if (fs.existsSync(summaryFile)) await fsp.unlink(summaryFile);
  }
}
