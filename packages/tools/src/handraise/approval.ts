/**
 * Typed approval request/reply payloads carried over the handraise transport.
 *
 * Approval is one specific shape of handraise: instead of an open-ended
 * question, the agent asks "may I run this command?" and the responder
 * picks one of four choices (Allow Once / Allow Session / Always Allow /
 * Deny). The choice maps to caching policy (see ApprovalPolicyStore):
 *
 *   - once:    proceed this time, do not cache
 *   - session: proceed and cache for this sessionKey for the rest of the run
 *   - always:  proceed and cache permanently (per tenant)
 *   - deny:    abort the tool call with an error
 *
 * Wire format note: this travels inside the existing HandraiseRequestPayload
 * via `context.kind === 'approval'`. We don't introduce a new topic — any
 * subscriber that doesn't understand approvals just treats it as a regular
 * handraise and the user can still text-reply.
 */

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny';

export interface ApprovalRequest {
  kind: 'approval';
  /**
   * Stable key identifying the action being approved. Same string for
   * "rm -rf /tmp/cache" called twice → session/always cache matches.
   * Caller's responsibility to normalize (e.g., strip volatile timestamps).
   */
  approvalKey: string;
  /** Short human-readable label shown in the prompt. */
  command: string;
  /** Why the agent wants to run this. */
  reason: string;
  /**
   * Session key (built by buildSessionKey) — used for session-scope caching
   * and to disambiguate concurrent approvals in the same channel.
   */
  sessionKey: string;
  /** Optional Discord user IDs allowed to click. */
  allowedUsers?: ReadonlyArray<string>;
  /** Optional Discord role IDs allowed to click. */
  allowedRoles?: ReadonlyArray<string>;
  /**
   * Subset of choices to offer. Default: all four. Use a smaller list to
   * remove ambiguity (e.g., destructive actions should not offer `always`).
   */
  choices?: ReadonlyArray<ApprovalChoice>;
  /**
   * Optional explicit Discord channel id where the prompt should be posted.
   * When omitted, the bridge falls back to parsing `sessionKey`.
   */
  channelId?: string;
  /** Optional Discord thread id (preferred target if present). */
  threadId?: string;
}

export interface ApprovalReply {
  choice: ApprovalChoice;
  /** Identity of the responder, for audit. */
  userId?: string;
  displayName?: string;
}

/** Type guard for narrowing a generic handraise context to an approval. */
export function isApprovalRequest(value: unknown): value is ApprovalRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'approval' &&
    typeof (value as ApprovalRequest).approvalKey === 'string' &&
    typeof (value as ApprovalRequest).sessionKey === 'string'
  );
}
