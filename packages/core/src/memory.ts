/**
 * CoreMemoryProvider — store 연동 MemoryProvider 구현.
 *
 * append/getHistory/clear는 ConversationStore에 위임.
 * compact는 별도 Compactor 객체에 위임.
 */

import type {
  MemoryProvider,
  ChatMessage,
  ConversationStore,
} from '@dongkseo/contracts';
import type { Compactor } from './compaction.js';

export interface CoreMemoryProviderOptions {
  /** 영속화 store */
  store: ConversationStore;
  /** 대화 ID */
  conversationId: string;
  /** 압축기 (선택) */
  compactor?: Compactor;
  /** 히스토리 메모리 캐시 사용 (기본 true) */
  cacheInMemory?: boolean;
}

export class CoreMemoryProvider implements MemoryProvider {
  private readonly store: ConversationStore;
  private readonly conversationId: string;
  private readonly compactor?: Compactor;
  private readonly cacheInMemory: boolean;
  private cache: ChatMessage[] | null = null;

  constructor(options: CoreMemoryProviderOptions) {
    this.store = options.store;
    this.conversationId = options.conversationId;
    this.compactor = options.compactor;
    this.cacheInMemory = options.cacheInMemory ?? true;
  }

  async append(message: ChatMessage): Promise<void> {
    await this.store.appendMessage(this.conversationId, message);
    if (this.cache) this.cache.push(message);
  }

  async getHistory(limit?: number): Promise<ChatMessage[]> {
    if (this.cacheInMemory && this.cache) {
      return limit !== undefined ? this.cache.slice(-limit) : [...this.cache];
    }

    const messages = await this.store.getHistory(this.conversationId, limit);
    if (this.cacheInMemory && limit === undefined) {
      this.cache = [...messages];
    }
    return messages;
  }

  async compact(): Promise<string | null> {
    if (!this.compactor) return null;

    const messages = await this.getHistory();
    const result = await this.compactor.compact(messages);
    if (!result) return null;

    // 압축된 메시지로 교체: store에 새 히스토리 기록
    await this.store.deleteConversation(this.conversationId);
    for (const msg of result.newMessages) {
      await this.store.appendMessage(this.conversationId, msg);
    }
    await this.store.saveCompaction(this.conversationId, result.summary);

    this.cache = [...result.newMessages];
    return result.summary;
  }

  async clear(): Promise<void> {
    await this.store.deleteConversation(this.conversationId);
    this.cache = null;
  }
}
