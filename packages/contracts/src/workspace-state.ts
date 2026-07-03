/**
 * Workspace-state persistence contract.
 *
 * Binds a conversation to its latest workspace snapshot so the next turn of the
 * same conversation can recover its filesystem. This is *separate-but-linked*:
 * a different store from the transcript (system of record), keyed by the same
 * `conversationId`. Only the most recent snapshot per conversation is kept
 * (save overwrites); history/rollback is a non-goal.
 *
 * Implementations live outside @dongkseo/contracts (file-based in
 * @dongkseo/store-json, Postgres in @dongkseo/store-pg). The orchestrator that
 * reads/writes it is `ContinuousWorkspaceProvider` in @dongkseo/core.
 */

import type { SandboxSessionState } from './workspace.js';

export interface WorkspaceStateStore {
  /** Latest reconnect state for a conversation, or null if none persisted yet. */
  load(conversationId: string): Promise<SandboxSessionState | null>;
  /** Persist (insert or overwrite) the latest reconnect state for a conversation. */
  save(conversationId: string, state: SandboxSessionState): Promise<void>;
  /** Drop a conversation's reconnect-state record (e.g. on conversation end). */
  delete(conversationId: string): Promise<void>;
}
