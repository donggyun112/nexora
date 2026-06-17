/**
 * TreeConversationStorePg — PostgreSQL-backed session tree with branching.
 */

import { messageId } from '@dongkseo/contracts';
import type {
  SessionEntry,
  SessionTreeNode,
  TreeConversationStore,
  AppendEntryInput,
  StoreBackendInfo,
  DescribableStore,
} from '@dongkseo/contracts';
import type { Sql } from './pg-client.js';
import { jsonParam } from './helpers.js';

export class TreeConversationStorePg implements TreeConversationStore, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async appendEntry(conversationId: string, entry: AppendEntryInput): Promise<string> {
    const id = messageId();

    let parentId = entry.parentId;
    if (parentId === undefined) {
      parentId = await this.getActiveLeaf(conversationId);
    }

    await this.sql`
      INSERT INTO nexora_session_tree (id, conversation_id, parent_id, role, content, metadata)
      VALUES (${id}, ${conversationId}, ${parentId ?? null}, ${entry.role}, ${entry.content}, ${entry.metadata ? jsonParam(this.sql, entry.metadata) : null})
    `;

    await this.sql`
      INSERT INTO nexora_session_leaf (conversation_id, leaf_id)
      VALUES (${conversationId}, ${id})
      ON CONFLICT (conversation_id) DO UPDATE SET leaf_id = ${id}
    `;

    return id;
  }

  async branch(conversationId: string, fromEntryId: string): Promise<void> {
    const rows = await this.sql`
      SELECT id FROM nexora_session_tree
      WHERE conversation_id = ${conversationId} AND id = ${fromEntryId}
    `;
    if (rows.length === 0) {
      throw new Error(`Entry "${fromEntryId}" not found in conversation "${conversationId}"`);
    }

    await this.sql`
      INSERT INTO nexora_session_leaf (conversation_id, leaf_id)
      VALUES (${conversationId}, ${fromEntryId})
      ON CONFLICT (conversation_id) DO UPDATE SET leaf_id = ${fromEntryId}
    `;
  }

  async getTree(conversationId: string): Promise<SessionTreeNode[]> {
    const rows = await this.sql`
      SELECT id, parent_id, role, content, metadata, created_at
      FROM nexora_session_tree
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at ASC
    `;

    const byId = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];

    for (const r of rows) {
      const entry: SessionEntry = {
        id: r.id as string,
        parentId: (r.parent_id as string | null) ?? null,
        role: r.role as 'user' | 'assistant',
        content: r.content as string,
        timestamp: new Date(r.created_at as string).getTime(),
        metadata: r.metadata as Record<string, unknown> | undefined,
      };
      byId.set(entry.id, { entry, children: [] });
    }

    for (const r of rows) {
      const node = byId.get(r.id as string)!;
      if (r.parent_id == null) {
        roots.push(node);
      } else {
        const parent = byId.get(r.parent_id as string);
        if (parent) parent.children.push(node);
        else roots.push(node);
      }
    }

    return roots;
  }

  async buildContext(
    conversationId: string,
    leafId?: string,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const targetLeaf = leafId ?? await this.getActiveLeaf(conversationId);
    if (!targetLeaf) return [];

    // Recursive CTE to walk from leaf to root
    const rows = await this.sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, role, content, created_at
        FROM nexora_session_tree
        WHERE conversation_id = ${conversationId} AND id = ${targetLeaf}
        UNION ALL
        SELECT t.id, t.parent_id, t.role, t.content, t.created_at
        FROM nexora_session_tree t
        JOIN chain c ON t.id = c.parent_id AND t.conversation_id = ${conversationId}
      )
      SELECT role, content FROM chain ORDER BY created_at ASC
    `;

    return rows.map(r => ({
      role: r.role as 'user' | 'assistant',
      content: r.content as string,
    }));
  }

  async getActiveLeaf(conversationId: string): Promise<string | null> {
    const rows = await this.sql`
      SELECT leaf_id FROM nexora_session_leaf WHERE conversation_id = ${conversationId}
    `;
    return rows.length > 0 ? rows[0].leaf_id as string : null;
  }

  async listLeaves(conversationId: string): Promise<string[]> {
    // Leaves = entries with no children
    const rows = await this.sql`
      SELECT t.id FROM nexora_session_tree t
      WHERE t.conversation_id = ${conversationId}
        AND NOT EXISTS (
          SELECT 1 FROM nexora_session_tree c
          WHERE c.conversation_id = ${conversationId} AND c.parent_id = t.id
        )
    `;
    return rows.map(r => r.id as string);
  }
}
