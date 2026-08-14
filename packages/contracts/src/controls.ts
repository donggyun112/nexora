/**
 * Tool-call decision contract — the control point between "the model wants this
 * tool" and "the executor runs it".
 *
 * Observation and decision are different things. An event says what happened and
 * nobody waits on it; a control point returns something load-bearing that the
 * runtime acts on, so its ordering and its failure behavior are part of the
 * execution contract. Today there is no such point in the tool path: the loop
 * goes straight from the model's tool_calls to `services.tools.executeBatch`,
 * which is why an approval gate has to wrap each tool individually and block on
 * a human answer with a wall-clock timeout — the one thing
 * `./suspended-turn.js` says must not happen ("the turn does not block on a
 * timeout — it suspends").
 *
 * This module only declares the decision type and the shape of the hooks that
 * return one. Nothing here executes, publishes, or persists anything. A gate is
 * an ordinary async function; the runtime asks it, and honors the answer.
 *
 * Stages may be re-run during recovery (a resumed turn revalidates), so a gate
 * must be idempotent.
 */

import type { ToolBatchCall } from './agent.js';
import { conversationId, spanId, traceId } from './id.js';
import type { MessageEnvelope } from './message.js';
import type { ToolContext, ToolResult } from './tool.js';

/**
 * What to ask while a call is parked — the question as data, not as a side
 * effect.
 *
 * Only the two things the runtime cannot know are here: which topic the
 * question goes on, and what the payload says. The correlation id (`pendingId`,
 * which is also the question envelope's `id`) and the envelope metadata are
 * filled in by the runtime, so exactly one place decides who mints that id.
 */
export interface SuspendRequest {
  /** Topic the question is published on (e.g. `handraise.human.<channel>`). */
  readonly topic: string;
  /** Wire payload, minus `pendingId` — the runtime merges that in. */
  readonly payload: Record<string, unknown>;
}

/**
 * What a gate decides about one requested tool call.
 *
 * The discriminant is `kind`, not `type`, on purpose: a decision and a
 * `ToolResult` travel together — `{kind:'deny'}` carries a `{type:'error'}`
 * result — and reusing one key for both would make that line unreadable.
 */
export type ToolDecision =
  /** Run the call as the model asked. */
  | { readonly kind: 'continue' }
  /** Do not run the call; this result is what the model sees instead. */
  | { readonly kind: 'deny'; readonly result: ToolResult }
  /**
   * Park the call, and say what to ask — as data. The gate decides the question
   * and publishes nothing, so it has no side effect and re-running it during
   * recovery cannot put a second question on the wire. Same shape as python's
   * `Suspend(request)`.
   *
   * The runtime publishes it, and only *after* the park has been recorded
   * (`RuntimeServices.onSuspend` → `core/src/bootstrap.ts`). The other order is
   * the bug this replaces: the question goes out, the process dies before the
   * park is persisted, and the answer comes back to a turn nobody parked. The
   * `pendingId` — the question envelope's id — is minted by the runtime too.
   */
  | { readonly kind: 'suspend'; readonly request: SuspendRequest };

/** Allow the call through. */
export function continueDecision(): ToolDecision {
  return { kind: 'continue' };
}

/** Block the call and hand the model `result` in its place. */
export function denyDecision(result: ToolResult): ToolDecision {
  return { kind: 'deny', result };
}

/** Park the call and hand the runtime the question to publish. */
export function suspendDecision(request: SuspendRequest): ToolDecision {
  return { kind: 'suspend', request };
}

/**
 * Build the question envelope for a `SuspendRequest`. One copy, because the two
 * publishers — the runtime after it persisted the park, and `gateTool` for the
 * tool-wrapper path — must put the same thing on the wire.
 *
 * `id` is the `pendingId`: a reply's `metadata.replyTo` is set to the question
 * envelope's id, so those two being the same value is what lets the answer find
 * the parked turn. The payload repeats it, unchanged from what the handraise
 * tool has always published.
 */
export function suspendEnvelope(
  pendingId: string,
  request: SuspendRequest,
  tenantId: string,
): MessageEnvelope {
  return {
    id: pendingId,
    topic: request.topic,
    type: 'request',
    payload: { ...request.payload, pendingId },
    metadata: {
      traceId: traceId(),
      spanId: spanId(),
      conversationId: conversationId(),
      tenantId,
      timestamp: Date.now(),
    },
  };
}

/** What a gate gets to decide with. */
export interface ToolGateInfo {
  /** The call as the model issued it. */
  readonly call: ToolBatchCall;
  /**
   * Execution context from `services.tools.getContext?.()` — where `tenantId`,
   * `logger`, `workspace` and the rest live. Optional because `getContext` is an
   * optional method on `ToolExecutor`; a gate that needs the tenant must handle
   * its absence rather than assume it.
   */
  readonly context?: ToolContext;
}

/**
 * Asked once per tool call, before the executor is touched. Unset (see
 * `RuntimeServices.preToolUse`) means no gating.
 */
export type PreToolUse = (info: ToolGateInfo) => Promise<ToolDecision>;

/** The answer that came back for a parked call. */
export interface ResumeAnswer {
  /** The `pendingId` the call was parked under. */
  readonly pendingId: string;
  /**
   * Raw answer payload from the reply. NOT pre-formatted into a ToolResult.
   *
   * The current resume path (`core/src/bootstrap.ts`, `resumeHandraiseTurn`)
   * wraps the answer in `textResult(...)` before handing it over, which throws
   * away the one thing an approval decision needs to read: whether the human
   * said yes or no. Formatting is what you do *after* deciding, not before.
   */
  readonly answer: unknown;
  /** Free-text reasoning the responder attached, when there was any. */
  readonly rationale?: string;
}

/**
 * Revalidate a parked call and its answer under the *current* policy. Policy can
 * change while a call sits parked, so the answer alone is not enough to decide —
 * the call has to be re-judged.
 *
 * The three returns mean:
 *   - `continue` — run the tool now; its result becomes the resumed call's result.
 *   - `deny`     — that result becomes the resumed call's result; the tool never runs.
 *   - `suspend`  — park it again, because revalidation concluded it must be asked
 *                  again (a new `pendingId`, published by the gate).
 *
 * Unset (see `RuntimeServices.onResume`) keeps today's behavior: the answer is
 * injected as the suspended call's result.
 */
export type OnResume = (
  info: ToolGateInfo & { readonly resume: ResumeAnswer },
) => Promise<ToolDecision>;

/**
 * Compose gates so denial wins and allowance does not short-circuit: every stage
 * runs in order until one denies, the first `suspend` is remembered but keeps
 * going (a later stage may still deny), and the result is that remembered
 * suspend, or `continue` when no stage objected. Same rule as python
 * `Permissions.__call__`.
 *
 * Running every stage to the end costs nothing: a `suspend` is a request the
 * stage returned, not a question it sent, so a later `deny` discards it and
 * nothing was published.
 */
export function composePreToolUse(...stages: PreToolUse[]): PreToolUse {
  return async (info) => {
    let asked: ToolDecision | undefined;
    for (const stage of stages) {
      const decision = await stage(info);
      if (decision.kind === 'deny') return decision;
      if (decision.kind === 'suspend' && asked === undefined) asked = decision;
    }
    return asked ?? continueDecision();
  };
}
