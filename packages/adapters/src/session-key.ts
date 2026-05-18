/**
 * Platform-agnostic session key builder.
 *
 * Ported from hermes-agent/gateway/session.py:build_session_key. The same
 * isolation rules govern Discord threads, Slack threads, Telegram forum
 * topics — anywhere conversations branch.
 *
 * Rules (mirrors hermes):
 *   - DMs: chat_id (and thread_id if present) define a unique session; never shared.
 *   - Group + no thread: optionally per-user when `groupSessionsPerUser` (default true).
 *   - Group + thread: shared by default. Per-user only when `threadSessionsPerUser`.
 *   - Missing identifiers fall back to platform/chat_type-scoped session.
 *
 * The returned key is the value stored in InboundMessage.conversationId, so
 * downstream stores can index by it without knowing platform specifics.
 */

export type ChatType = 'dm' | 'group' | 'channel';

export interface SessionSource {
  platform: string;
  chatType: ChatType;
  chatId?: string | null;
  threadId?: string | null;
  userId?: string | null;
}

export interface SessionKeyOptions {
  /**
   * Isolate group/channel sessions per user. Default true.
   * When false, every participant in the channel shares the same session.
   */
  groupSessionsPerUser?: boolean;
  /**
   * Isolate thread sessions per user. Default false.
   * Threads are typically a shared back-and-forth, so users share by default.
   */
  threadSessionsPerUser?: boolean;
  /**
   * Optional namespace prefix. Defaults to `agent:main` to match hermes.
   */
  namespace?: string;
}

const DEFAULT_NAMESPACE = 'agent:main';

export function buildSessionKey(
  source: SessionSource,
  options: SessionKeyOptions = {},
): string {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const groupSessionsPerUser = options.groupSessionsPerUser ?? true;
  const threadSessionsPerUser = options.threadSessionsPerUser ?? false;

  const { platform, chatType, chatId, threadId, userId } = source;

  if (chatType === 'dm') {
    if (chatId) {
      if (threadId) return `${namespace}:${platform}:dm:${chatId}:${threadId}`;
      return `${namespace}:${platform}:dm:${chatId}`;
    }
    if (threadId) return `${namespace}:${platform}:dm:${threadId}`;
    return `${namespace}:${platform}:dm`;
  }

  const parts = [namespace, platform, chatType];
  if (chatId) parts.push(chatId);
  if (threadId) parts.push(threadId);

  let isolateUser = groupSessionsPerUser;
  if (threadId && !threadSessionsPerUser) isolateUser = false;

  if (isolateUser && userId) parts.push(userId);

  return parts.join(':');
}

/**
 * Whether a non-DM session is shared across participants given the same
 * options. Useful for adapters that want to decide whether to surface
 * per-user context (e.g., "@username said …") in shared sessions.
 */
export function isSharedSession(
  source: SessionSource,
  options: SessionKeyOptions = {},
): boolean {
  if (source.chatType === 'dm') return false;
  if (source.threadId) return !(options.threadSessionsPerUser ?? false);
  return !(options.groupSessionsPerUser ?? true);
}
