/**
 * Runtime control points — the places where the loop stops and asks policy
 * before it acts, and the rules for composing several policies into one.
 *
 * The oldest of them is the tool gate: the control point between "the model
 * wants this tool" and "the executor runs it".
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

import type { LLMMessage, PendingRuntimeInput, ToolBatchCall } from './agent.js';
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

// ── the turn-level control points ────────────────────────────────────────────

/**
 * Why a run ended, carried on the terminal `done` event.
 *
 * `aborted` matters most: a cancelled run must leave a record, not just a
 * stream that stops.
 */
export type StopReason = 'completed' | 'aborted' | 'tool' | 'policy';

/**
 * Shared run context handed to every turn-level control point.
 *
 * This coexists with `ToolGateInfo` on purpose: the tool gate is asked about
 * one call and its consumers want the *execution* context (tenant, workspace,
 * logger) from `ToolExecutor.getContext()`, while a turn-level hook is asked
 * about the run and wants the *conversation* so far. Neither is a superset of
 * the other, and merging them would force every gate to carry a message log it
 * never reads.
 */
export interface ControlContext {
  /** Loop iteration this decision belongs to, 0-based. */
  readonly turn: number;
  /** The conversation as the runtime will send it. */
  readonly messages: readonly LLMMessage[];
  /** Tool calls already executed in this run. */
  readonly callsMade: readonly ToolBatchCall[];
  /** Assistant text accumulated in the current round. */
  readonly text: string;
  /**
   * Who the run acts for, as the host names them. **Never interpreted here.**
   *
   * A user id, a service account, a tenant-scoped pair, whatever an external
   * directory calls a principal — this runtime cannot know which, so it carries
   * the string and reads nothing out of it. Empty means the host did not say,
   * which is the honest default: a framework that invented a subject would be
   * putting a name it made up into an audit record.
   *
   * It reaches the record two ways, and both matter. A stage may decide with it
   * — a gate that asks a directory per call needs to know who is asking. And it
   * is stamped onto every tool event and onto a suspension, so "who was this
   * denied for" and "whose authority was this parked under" have answers that do
   * not depend on correlating by run id afterwards.
   */
  readonly subject: string;
}

/**
 * What a turn-level control point decides: keep going (optionally injecting
 * steering messages first), or end the run with a terminal reason.
 */
export type TurnDecision =
  | { readonly kind: 'proceed'; readonly steers: readonly LLMMessage[] }
  | { readonly kind: 'halt'; readonly reason: StopReason };

/** The halting half of `TurnDecision`, named because `OnInputs` returns only it. */
export type HaltDecision = Extract<TurnDecision, { kind: 'halt' }>;

/** Keep going, injecting `steers` (if any) before the next model call. */
export function proceedDecision(steers: readonly LLMMessage[] = []): TurnDecision {
  return { kind: 'proceed', steers };
}

/** End the run, recording why. */
export function haltDecision(reason: StopReason): HaltDecision {
  return { kind: 'halt', reason };
}

/**
 * Rewrite, drop, or halt inputs before they enter model context. Returns the
 * inputs that survive screening — an empty array is a legitimate answer
 * ("nothing here is admissible"), distinct from halting the run.
 */
export type OnInputs = (
  ctx: ControlContext,
  inputs: PendingRuntimeInput[],
) => Promise<PendingRuntimeInput[] | HaltDecision>;

/** Return steering messages or halt before a model call. */
export type BeforeModel = (ctx: ControlContext) => Promise<TurnDecision>;

/**
 * Record and validate a tool result, propagating failures. Returns nothing: a
 * writer that objects does it by throwing, which stops the attempt rather than
 * becoming a model-visible tool failure.
 */
export type AfterToolCall = (
  ctx: ControlContext,
  call: ToolBatchCall,
  result: unknown,
) => Promise<void>;

/**
 * Accept completion or veto it with steering for another round.
 *
 * This is what replaces a boolean "should I stop?": returning `halt` accepts the
 * ending, and returning `proceed` refuses it — the steers are the reason the run
 * gets another round, so a verification gate can say *what was missing* instead
 * of only "not yet". `reason` is the ending being judged; a hook that accepts it
 * should hand it back unchanged rather than substitute one of its own.
 */
export type BeforeFinish = (ctx: ControlContext, reason: StopReason) => Promise<TurnDecision>;

/**
 * Chain input screens so each sees the previous screen's output — a screen that
 * rewrites inputs is visible to the ones after it. A `halt` short-circuits.
 */
export function composeOnInputs(...screens: OnInputs[]): OnInputs {
  return async (ctx, inputs) => {
    for (const screen of screens) {
      const screened = await screen(ctx, inputs);
      if (!Array.isArray(screened)) return screened;
      inputs = screened;
    }
    return inputs;
  };
}

/**
 * Accumulate pre-model steering in order unless a source halts — the first
 * `halt` wins immediately and the remaining sources are not asked.
 *
 * This is deliberately **asymmetric** with `composeBeforeFinish`, where a halt
 * is the fallback and only an explicit `proceed` overrides it. The asymmetry is
 * the point: refusing to *finish* keeps the loop running, so that side must
 * require an explicit `proceed` from somebody or a silent stage could keep a run
 * alive forever. Refusing to *start* a model call cannot loop, so the cheap rule
 * is safe here.
 */
export function composeBeforeModel(...sources: BeforeModel[]): BeforeModel {
  return async (ctx) => {
    const steers: LLMMessage[] = [];
    for (const source of sources) {
      const action = await source(ctx);
      if (action.kind === 'halt') return action;
      steers.push(...action.steers);
    }
    return proceedDecision(steers);
  };
}

/** Run result writers in order and propagate the first failure. */
export function composeAfterToolCall(...writers: AfterToolCall[]): AfterToolCall {
  return async (ctx, call, result) => {
    for (const write of writers) await write(ctx, call, result);
  };
}

/**
 * Compose completion verifiers and accumulate steering from vetoes: every gate
 * is asked, the steers of every `proceed` are concatenated in order, and the run
 * continues if *any* gate vetoed. Anything other than `proceed` means "no
 * objection" — a gate that halts is agreeing with the ending, not overriding it.
 *
 * When nobody vetoes, the result is `halt(reason)` with the **original** reason.
 * That is what keeps `aborted` from being laundered into `completed` by a policy
 * layer that merely had nothing to say.
 *
 * See `composeBeforeModel` for why the two turn-level composers are asymmetric.
 */
export function composeBeforeFinish(...gates: BeforeFinish[]): BeforeFinish {
  return async (ctx, reason) => {
    const steers: LLMMessage[] = [];
    let vetoed = false;
    for (const gate of gates) {
      const decision = await gate(ctx, reason);
      if (decision.kind !== 'proceed') continue;
      vetoed = true;
      steers.push(...decision.steers);
    }
    return vetoed ? proceedDecision(steers) : haltDecision(reason);
  };
}

// ── the facade ───────────────────────────────────────────────────────────────

/** Every control point, each optional. */
export interface ControlPlaneHooks {
  readonly onInputs?: OnInputs;
  readonly beforeModel?: BeforeModel;
  readonly preToolUse?: PreToolUse;
  readonly afterToolCall?: AfterToolCall;
  readonly beforeFinish?: BeforeFinish;
  readonly onResume?: OnResume;
}

/** The same set, all present — what the runtime actually calls. */
export type ControlPlane = Required<ControlPlaneHooks>;

/**
 * Fill in the unset control points with their permissive defaults, so the
 * runtime calls the same six functions whether or not an app configured any.
 * The result is spreadable into `RuntimeServices`.
 *
 * A factory rather than a class: these are plain async functions, and the
 * runtime wants them as properties it can spread, not methods bound to an
 * instance.
 *
 * "Permissive" has one exception, and it is the important one: an unset
 * `beforeFinish` **halts** with the reason it was given. Nobody objected, so the
 * run ends — the default for a completion gate is to accept the ending, not to
 * keep going. `onResume` has the other one: an error answer is denied *before*
 * the hook is consulted, because a hook cannot revalidate an answer that never
 * arrived.
 */
export function createControlPlane(hooks: ControlPlaneHooks = {}): ControlPlane {
  return {
    onInputs: hooks.onInputs ?? (async (_ctx, inputs) => inputs),
    beforeModel: hooks.beforeModel ?? (async () => proceedDecision()),
    preToolUse: hooks.preToolUse ?? (async () => continueDecision()),
    afterToolCall: hooks.afterToolCall ?? (async () => {}),
    beforeFinish: hooks.beforeFinish ?? (async (_ctx, reason) => haltDecision(reason)),
    onResume: async (info) => {
      const answer = info.resume.answer;
      if (isErrorAnswer(answer)) return denyDecision(answer);
      if (hooks.onResume === undefined) return continueDecision();
      return hooks.onResume(info);
    },
  };
}

/**
 * An answer that is itself an error result. `ResumeAnswer.answer` is `unknown`
 * on purpose (see its TSDoc), so the shape has to be checked rather than
 * assumed.
 */
function isErrorAnswer(answer: unknown): answer is Extract<ToolResult, { type: 'error' }> {
  return (
    typeof answer === 'object'
    && answer !== null
    && (answer as { type?: unknown }).type === 'error'
    && typeof (answer as { message?: unknown }).message === 'string'
  );
}
