/**
 * ConversationStorePg — PostgreSQL-backed conversation store.
 *
 * Production-grade: durable, multi-process safe, survives restarts.
 */

import type { ConversationStore, ChatMessage, StoreBackendInfo, DescribableStore } from '@dongkseo/contracts';
import { messageId } from '@dongkseo/contracts';
import type { Sql } from './pg-client.js';

export class ConversationStorePg implements ConversationStore, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async getHistory(conversationId: string, limit?: number): Promise<ChatMessage[]> {
    const rows = limit
      ? await this.sql`
          SELECT role, content FROM nexora_conversations
          WHERE conversation_id = ${conversationId}
          ORDER BY created_at ASC
          LIMIT ${limit}
        `
      : await this.sql`
          SELECT role, content FROM nexora_conversations
          WHERE conversation_id = ${conversationId}
          ORDER BY created_at ASC
        `;

    return rows.map(r => ({
      role: r.role as 'user' | 'assistant',
      content: r.content as string,
    }));
  }

  async appendMessage(conversationId: string, message: ChatMessage): Promise<void> {
    await this.sql`
      INSERT INTO nexora_conversations (id, conversation_id, role, content)
      VALUES (${messageId()}, ${conversationId}, ${message.role}, ${message.content})
    `;
  }

  async saveCompaction(conversationId: string, summary: string): Promise<void> {
    await this.sql`
      INSERT INTO nexora_compaction_summaries (conversation_id, summary, updated_at)
      VALUES (${conversationId}, ${summary}, NOW())
      ON CONFLICT (conversation_id) DO UPDATE SET summary = ${summary}, updated_at = NOW()
    `;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.sql`DELETE FROM nexora_conversations WHERE conversation_id = ${conversationId}`;
    await this.sql`DELETE FROM nexora_compaction_summaries WHERE conversation_id = ${conversationId}`;
  }
}
