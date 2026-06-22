/**
 * Suspended-turn persistence contract.
 *
 * When an agent calls `handraise` to ask a *human* and the answer cannot be
 * produced synchronously, the turn does not block on a timeout — it suspends.
 * The architecture emits `{type:'suspended'}` and calls `onSuspend(...)`, and
 * the turn's state is checkpointed here so it can be resumed when the human
 * eventually answers (possibly after a process restart).
 *
 * This mirrors `WorkflowStateStore` (checkpoint/resume) but is keyed by the
 * handraise `pendingId`. Implementations live outside @dongkseo/contracts
 * (in-memory in the orchestrator package, file-based in @dongkseo/store-json,
 * Postgres in @dongkseo/store-pg).
 */

import type { LLMMessage } from './agent.js';
import type { MessageEnvelope } from './message.js';

export interface SuspendedTurnState {
  /** Handraise pending id — the resume key. Supplied by the handraise tool. */
  pendingId: string;
  /** The suspended tool call's id — becomes `resumeContext.resumedCallId`. */
  toolCallId: string;
  /**
   * The architecture history captured at suspend time. Seeds `history` on
   * resume so the next LLM turn sees everything up to the suspended tool call.
   * Opaque to the store.
   */
  architectureHistory: LLMMessage[];
  /**
   * The original incoming envelope. Re-run rebuilds the AgentInput from this
   * via the agent's own `toAgentInput`, so no agent-specific input shape leaks
   * into the store.
   */
  envelope: MessageEnvelope;
  /** Topic the completed result must be published on once the turn resumes. */
  resultTopic: string;
  /** handraise channel (`handraise.human.<channel>`) — optional, for audit only. */
  channel?: string;
  /** The question text — optional, for display / audit. */
  question?: string;
  /** Tenant isolation — preserved across resume. */
  tenantId: string;
  /** Timestamp (ms) for debugging / cleanup. */
  createdAt: number;
  /** 'awaiting' is the normal state; 'resumed' guards against double-resume. */
  status: 'awaiting' | 'resumed';
}

export interface SuspendedTurnStore {
  /** Persist a suspended turn (insert or update by pendingId). */
  save(state: SuspendedTurnState): Promise<void>;
  /** Load a suspended turn by pendingId, or null if absent. */
  load(pendingId: string): Promise<SuspendedTurnState | null>;
  /** Delete a suspended turn once it has been resumed (or abandoned). */
  delete(pendingId: string): Promise<void>;
  /** All turns still awaiting an answer — for operator inspection / recovery. */
  listAwaiting(): Promise<SuspendedTurnState[]>;
}
