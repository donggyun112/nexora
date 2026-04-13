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
  /**
   * Parent entry ID:
   * - `null` = explicit root (first message in conversation)
   * - `string` = explicit parent
   * - `undefined` = auto-parent from current active leaf
   */
  parentId: string | null | undefined;
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
/** Input for appendEntry — parentId is optional (auto-parents from active leaf). */
export type AppendEntryInput = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
  /** null = root, string = explicit parent, omitted = auto-parent from active leaf */
  parentId?: string | null;
};

export interface TreeConversationStore {
  /**
   * Append an entry to the current branch. Returns the new entry ID.
   * - parentId omitted/undefined → auto-parent from active leaf
   * - parentId null → explicit root
   * - parentId string → explicit parent
   */
  appendEntry(conversationId: string, entry: AppendEntryInput): Promise<string>;

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
