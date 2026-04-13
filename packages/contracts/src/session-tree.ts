/**
 * Session Tree — branching conversation history.
 *
 * Instead of a flat ChatMessage[], a tree conversation stores entries
 * with id/parentId so the agent can:
 * - Branch at any point (explore alternative paths)
 * - Rewind to a previous state
 * - Build context from any leaf back to root
 *
 * The storage format is append-only JSONL: entries are never deleted,
 * only superseded by new branches. This preserves full history.
 */

export interface SessionEntry {
  /** Unique entry ID */
  id: string;
  /** Parent entry ID (null for root) */
  parentId: string | null;
  /** Message role */
  role: 'user' | 'assistant';
  /** Message content */
  content: string;
  /** Timestamp */
  timestamp: number;
  /** Optional metadata (tool calls, model, etc.) */
  metadata?: Record<string, unknown>;
}

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
}

/**
 * TreeConversationStore — extends basic conversation with branching.
 *
 * The default getHistory/append still work (they operate on the
 * "current branch" — the path from root to the active leaf).
 */
export interface TreeConversationStore {
  /** Append an entry to the current branch. Returns the new entry ID. */
  appendEntry(conversationId: string, entry: Omit<SessionEntry, 'id'>): Promise<string>;

  /**
   * Branch from a specific entry. Sets the active leaf to the new branch point.
   * Subsequent appendEntry calls will add to this new branch.
   */
  branch(conversationId: string, fromEntryId: string): Promise<void>;

  /** Get the full tree structure. */
  getTree(conversationId: string): Promise<SessionTreeNode[]>;

  /**
   * Build a linear ChatMessage[] from root to the specified leaf
   * (or the active leaf if not specified). This is what gets sent to the LLM.
   */
  buildContext(conversationId: string, leafId?: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>>;

  /** Get the current active leaf ID. */
  getActiveLeaf(conversationId: string): Promise<string | null>;

  /** List all leaf entry IDs (branch tips). */
  listLeaves(conversationId: string): Promise<string[]>;
}
