/**
 * delegate — runtime agent-to-agent task delegation.
 *
 * The agent calls this tool when its own tools aren't enough and another
 * agent declares the capability it needs.
 *
 * Cycle detection propagates via `metadata.delegationDepth` in the
 * MessageEnvelope so it works across processes. The old per-callId Map was
 * process-local and couldn't detect A→B→A cycles spanning two hosts.
 *
 * The delegate tool sets `metadata.callerAgent` so the receiving bootstrap
 * can enforce per-capability ACLs. Without this, any agent with the delegate
 * tool could invoke any advertised capability (confused deputy).
 */

import type {
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolLogger,
  EventTransport,
  AgentRegistry,
  AgentRuntime,
  AgentInput,
  AgentEvent,
  TopicString,
  MessageEnvelope,
} from '@dongkseo/contracts';
import {
  textResult,
  errorResult,
  messageId,
  traceId,
  spanId,
  conversationId,
} from '@dongkseo/contracts';
import { createApprovalGateMiddleware } from '../handraise/approval-middleware.js';
import type { ApprovalGateOptions } from '../handraise/approval-middleware.js';
import { InMemoryBackgroundTaskRegistry } from '@dongkseo/contracts';
import type { BackgroundTaskRegistry, BackgroundTaskResult } from '@dongkseo/contracts';

// ─── Subagent types (deepagents pattern) ────────────────────────────────

/** Declarative subagent — defined inline or via YAML, built at call time. */
export interface DeclarativeSubagent {
  type: 'declarative';
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
}

/** Pre-compiled subagent — an already-built AgentRuntime instance. */
export interface CompiledSubagent {
  type: 'compiled';
  name: string;
  description: string;
  runtime: AgentRuntime;
}

/** Async/remote subagent — reached via URL, fire-and-forget or poll. */
export interface AsyncSubagent {
  type: 'async';
  name: string;
  description: string;
  url: string;
  headers?: Record<string, string>;
  /** Timeout for the HTTP call. Default: 300_000. */
  timeoutMs?: number;
}

export type Subagent = DeclarativeSubagent | CompiledSubagent | AsyncSubagent;

/**
 * Factory for building an AgentRuntime from a DeclarativeSubagent spec.
 * The caller provides this so delegate doesn't depend on core internals.
 */
export type SubagentRuntimeFactory = (spec: DeclarativeSubagent) => AgentRuntime | Promise<AgentRuntime>;

/**
 * Builds a caller-owned runtime for a capability-resolved peer, so the peer can
 * run as a background subagent the caller owns (rather than an autonomous peer
 * reached over transport). Supplied by the app, which knows how to assemble a
 * runtime from a card (the framework cannot). When absent, async delegation to a
 * registry peer falls back to the legacy fire-and-forget publish.
 */
export type PeerRuntimeFactory = (
  capability: string,
  input: unknown,
  meta: { delegationDepth: number; callerAgent: string },
) => AgentRuntime | Promise<AgentRuntime>;

/** @deprecated Use BackgroundTaskResult. Kept for delegate's export surface. */
export type BackgroundSubagentResult = BackgroundTaskResult;

export interface DelegateToolOptions {
  transport: EventTransport;
  registry: AgentRegistry;
  /** This agent's name — propagated as callerAgent for auth. */
  callerAgentName: string;
  /** Maximum delegation depth before refusing. Default: 5. */
  maxDepth?: number;
  /** Default timeout for the delegated request. Default: 300_000 (5 min). */
  defaultTimeoutMs?: number;
  /**
   * Current delegation depth inherited from the envelope that triggered this
   * agent. Set by bootstrap from `envelope.metadata.delegationDepth`.
   * Defaults to 0 (first hop).
   */
  currentDepth?: number;
  /**
   * Tools blocked for child agents (hermes DELEGATE_BLOCKED_TOOLS pattern).
   * These tools are stripped from the child's toolset to prevent recursive
   * delegation, unauthorized user interaction, or shared state corruption.
   */
  blockedToolsForChild?: string[];
  /**
   * Inline subagents — resolved by name before checking the registry.
   * Supports declarative (built at call time), compiled (pre-built runtime),
   * and async (remote URL) subagent types.
   */
  subagents?: Subagent[];
  /**
   * Factory for building a runtime from a DeclarativeSubagent.
   * Required if any declarative subagents are registered.
   */
  runtimeFactory?: SubagentRuntimeFactory;
  /**
   * Progress relay callback — receives every AgentEvent from inline
   * subagent execution (compiled/declarative). Use to stream child
   * progress to the parent agent's UI or logging.
   */
  onSubagentEvent?: (subagentName: string, event: AgentEvent) => void;
  /**
   * Optional approval gate. When supplied, the returned tool definition is
   * wrapped with `createApprovalGateMiddleware`. The predicate receives the
   * raw delegate input (`{ capability, input, ... }`) and decides per-call
   * whether the hop needs human approval. Hardline rules (if any) fire
   * before the predicate and cannot be bypassed by mode='off'.
   *
   * Typical use: gate when `capability` falls into a tenant-defined "risky"
   * set (e.g. anything touching billing or production), or when the
   * delegation target is an external/async subagent.
   */
  approvalGate?: ApprovalGateOptions;
  /**
   * Builds a caller-owned runtime for a capability-resolved peer when
   * `delegate({ waitForResult: 'async' })` targets a registry agent. Enables
   * running that peer as a background subagent the caller owns. Without it,
   * async delegation to a peer keeps the legacy fire-and-forget publish.
   */
  peerRuntimeFactory?: PeerRuntimeFactory;
  /**
   * Shared registry tracking background subagent jobs. Pass the SAME instance to
   * `createCheckSubagentsTool` / `createCancelSubagentTool` so the agent can list
   * and cancel the children it launched. Defaults to a private instance (jobs
   * still run, but the control tools won't see them).
   */
  jobRegistry?: BackgroundTaskRegistry;
  /**
   * Delivers a background subagent's result when the parent turn has already
   * ended (so `ctx.steerSelf` can no longer fold it into the live turn). The app
   * wires this to start a new turn carrying the result. If absent, a result that
   * arrives after the parent turn ends is logged and dropped.
   */
  deliverResult?: (result: BackgroundSubagentResult) => void | Promise<void>;
  /**
   * Max wall-clock a background subagent may run before it is aborted and
   * settled as an error. Bounds hung children (the sync path has timeoutMs; the
   * background path otherwise relies only on the child runtime's own idle
   * timeout). Omit for no delegate-level cap.
   */
  backgroundJobTimeoutMs?: number;
}

/**
 * Default tools blocked for delegated child agents.
 * - delegate: prevent recursive delegation chains
 * - handraise: children shouldn't interact with humans directly
 * - skill-manage: children shouldn't create/modify skills
 */
const DEFAULT_BLOCKED_TOOLS_FOR_CHILD = ['delegate', 'handraise', 'skill-manage'];

interface DelegateParams {
  capability: string;
  input: unknown;
  timeoutMs?: number;
  /**
   * Result-handling mode. See wiki/decisions/2026-06-01-delegation-primitives.md.
   * - `'sync'` (default, legacy): RPC. Awaits reply within this turn.
   * - `false`: Fire-and-forget. Publishes a request envelope and returns
   *   immediately. The caller will NOT receive a result.
   * - `'async'`: Reserved. Will spawn a thread and route the eventual
   *   `*.completed/.failed` envelope back to the caller as a new turn.
   *   Not yet implemented — bootstrap/runner support pending.
   */
  waitForResult?: 'sync' | 'async' | false;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_TIMEOUT_MS = 300_000;

export function createDelegateTool(options: DelegateToolOptions): ToolDefinition {
  const {
    transport,
    registry,
    callerAgentName,
    maxDepth = DEFAULT_MAX_DEPTH,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    currentDepth = 0,
    blockedToolsForChild = DEFAULT_BLOCKED_TOOLS_FOR_CHILD,
    subagents = [],
    runtimeFactory,
    onSubagentEvent,
    approvalGate,
    peerRuntimeFactory,
    jobRegistry = new InMemoryBackgroundTaskRegistry(),
    deliverResult,
    backgroundJobTimeoutMs,
  } = options;

  // Index inline subagents by name for O(1) lookup
  const subagentsByName = new Map<string, Subagent>();
  for (const sa of subagents) {
    subagentsByName.set(sa.name, sa);
  }

  // Launch a caller-owned background subagent: resolve a child runtime (inline
  // subagent, else a capability-resolved peer via peerRuntimeFactory), pump it on
  // a detached loop, and return immediately so the parent's turn continues. The
  // child's result is folded back via ctx.steerSelf (live turn) or deliverResult
  // (parent turn ended). Returns null when no caller-owned child can be built, so
  // the caller falls through to the legacy async peer publish.
  async function startBackgroundSubagent(
    params: DelegateParams,
    ctx: ToolContext,
    nextDepth: number,
  ): Promise<ToolResult | null> {
    let childRuntime: AgentRuntime | null = null;
    let childName = params.capability;

    const inlineSa = subagentsByName.get(params.capability);
    try {
      if (inlineSa) {
        childName = inlineSa.name;
        if (inlineSa.type === 'compiled') {
          childRuntime = inlineSa.runtime;
        } else if (inlineSa.type === 'declarative') {
          if (!runtimeFactory) {
            return errorResult(
              `Cannot run declarative subagent "${inlineSa.name}" in background: no runtimeFactory provided`,
            );
          }
          childRuntime = await runtimeFactory(inlineSa);
        } else {
          return errorResult(
            `Remote (async) subagent "${inlineSa.name}" cannot run as a caller-owned background subagent`,
          );
        }
      } else if (peerRuntimeFactory) {
        const candidates = await registry.findByCapability(params.capability);
        if (candidates.length === 0) {
          return errorResult(`No agent declares capability "${params.capability}"`);
        }
        childName = candidates[0].name;
        childRuntime = await peerRuntimeFactory(params.capability, params.input, {
          delegationDepth: nextDepth,
          callerAgent: callerAgentName,
        });
      } else {
        // No inline subagent and no peer factory — caller can't own a child here.
        return null;
      }
    } catch (err) {
      ctx.logger.error('delegate.background.build_runtime_failed', {
        capability: params.capability,
        childName,
        err: err instanceof Error ? err.message : String(err),
      });
      return errorResult(`Failed to build background subagent for "${params.capability}"`);
    }

    // Prefer the runtime-injected registry/sink (tool-neutral, shared with the
    // check_tasks/cancel_task control tools); fall back to the per-tool options.
    // Note: `registry` (the AgentRegistry) is a different thing — don't shadow it.
    const taskRegistry = ctx.backgroundTasks ?? jobRegistry;
    const sink = ctx.deliverResult ?? deliverResult;

    if (!ctx.steerSelf && !sink) {
      return errorResult(
        'Background subagents need a steerable parent loop or a deliverResult sink; ' +
          'neither is available in this runtime. Use waitForResult:"sync" instead.',
      );
    }

    const jobId = messageId();
    taskRegistry.register({
      taskId: jobId,
      kind: 'subagent',
      label: childName,
      startedAt: Date.now(),
      abort: () => childRuntime.abort(),
    });
    ctx.logger.info('delegate.background.launched', {
      jobId,
      childName,
      capability: params.capability,
      depth: nextDepth,
    });

    void pumpBackgroundChild({
      jobId,
      childName,
      runtime: childRuntime,
      input: params.input,
      jobRegistry: taskRegistry,
      onSubagentEvent,
      steerSelf: ctx.steerSelf,
      deliverResult: sink,
      logger: ctx.logger,
      timeoutMs: backgroundJobTimeoutMs,
    });

    return textResult(
      `[subagent ${childName}] launched as background job ${jobId}. ` +
        `Keep working — its result arrives in this turn if you're still active, otherwise as a follow-up. ` +
        `Use check_tasks for status, or cancel_task with task id "${jobId}" to stop it.`,
    );
  }

  const toolDef: ToolDefinition = {
    name: 'delegate',
    description:
      'Delegate a subtask to another agent by capability. The framework ' +
      'looks up which agent can handle the capability, sends the request, ' +
      'and returns the result. You specify a CAPABILITY, not an agent name.',
    parameters: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'Required capability (e.g. "code-review", "summarization")',
        },
        input: {
          description: 'Payload to send to the target agent',
        },
        timeoutMs: {
          type: 'number',
          description: `Max wait time in ms (sync mode only). Default ${DEFAULT_TIMEOUT_MS}.`,
        },
        waitForResult: {
          description:
            'Result handling. "sync" (default): wait for the reply this turn. ' +
            'false: fire-and-forget, no result returned. ' +
            '"async": run as a background subagent — returns immediately and its ' +
            'result is folded into your turn when ready (or arrives as a follow-up). ' +
            'Use check_subagents / cancel_subagent to manage it.',
        },
      },
      required: ['capability', 'input'],
    },
    execute: async (_callId, rawInput, ctx): Promise<ToolResult> => {
      const params = rawInput as DelegateParams;

      if (!params.capability || typeof params.capability !== 'string') {
        return errorResult('capability is required');
      }
      if (params.input === undefined) {
        return errorResult('input is required');
      }

      const nextDepth = currentDepth + 1;
      if (nextDepth > maxDepth) {
        return errorResult(
          `Delegation depth ${nextDepth} exceeds max ${maxDepth}. ` +
          `This usually means agents are delegating in a cycle. ` +
          `Review the capability graph.`,
        );
      }

      // ── Background subagent (async): caller-owned child pumped concurrently ──
      // Returns null when no caller-owned child can be built (no inline subagent
      // and no peerRuntimeFactory) — then fall through to the existing paths,
      // where 'async' keeps the legacy fire-and-forget peer publish.
      if (params.waitForResult === 'async') {
        const bg = await startBackgroundSubagent(params, ctx, nextDepth);
        if (bg) return bg;
      }

      // ── Try inline subagents first ──────────────────────────────────
      const inlineSa = subagentsByName.get(params.capability);
      if (inlineSa) {
        ctx.logger.info('delegate.inline', { type: inlineSa.type, name: inlineSa.name });
        return executeSubagent(inlineSa, params, ctx, runtimeFactory, onSubagentEvent);
      }

      // ── Fall back to registry-based transport delegation ────────────
      const candidates = await registry.findByCapability(params.capability);
      if (candidates.length === 0) {
        return errorResult(`No agent declares capability "${params.capability}"`);
      }

      const target = candidates[0];
      const targetTopic = target.subscribes[0];
      if (!targetTopic) {
        return errorResult(
          `Agent "${target.name}" declares capability "${params.capability}" ` +
          `but has no subscribed topics`,
        );
      }

      const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
        ? params.timeoutMs
        : defaultTimeoutMs;

      const waitMode: 'sync' | 'async' | false =
        params.waitForResult === undefined ? 'sync' : params.waitForResult;

      ctx.logger.info('delegate', {
        capability: params.capability,
        target: target.name,
        topic: targetTopic,
        depth: nextDepth,
        caller: callerAgentName,
        waitMode,
        timeoutMs: waitMode === 'sync' ? timeoutMs : undefined,
      });

      if (waitMode === 'async') {
        try {
          const envelopeId = messageId();
          const envelope: MessageEnvelope = {
            id: envelopeId,
            topic: targetTopic,
            type: 'request',
            payload: params.input,
            metadata: {
              traceId: traceId(),
              spanId: spanId(),
              conversationId: conversationId(),
              tenantId: ctx.tenantId,
              sourceInstanceId: callerAgentName,
              callerAgent: callerAgentName,
              delegationDepth: nextDepth,
              timestamp: Date.now(),
            },
          };
          await transport.publish(envelope);
          return textResult(
            `Dispatched to "${target.name}" (${params.capability}) — async. ` +
            `Result will arrive on a later turn as topic "${targetTopic}.completed" ` +
            `or ".failed" with metadata.replyTo="${envelopeId}". ` +
            `Subscribe via createEphemeralResultListener if needed.`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult(`async delegate to "${target.name}" failed: ${msg}`);
        }
      }

      if (waitMode === false) {
        try {
          const envelope: MessageEnvelope = {
            id: messageId(),
            topic: targetTopic,
            type: 'request',
            payload: params.input,
            metadata: {
              traceId: traceId(),
              spanId: spanId(),
              conversationId: conversationId(),
              tenantId: ctx.tenantId,
              sourceInstanceId: callerAgentName,
              callerAgent: callerAgentName,
              delegationDepth: nextDepth,
              timestamp: Date.now(),
            },
          };
          await transport.publish(envelope);
          return textResult(
            `Dispatched to "${target.name}" (${params.capability}) — fire-and-forget. ` +
            `No result will be returned.`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult(`fire-forget delegate to "${target.name}" failed: ${msg}`);
        }
      }

      try {
        const reply = await transport.request(
          targetTopic as TopicString,
          params.input,
          {
            timeoutMs,
            tenantId: ctx.tenantId,
            delegationDepth: nextDepth,
            callerAgent: callerAgentName,
            blockedTools: blockedToolsForChild,
          },
        );

        const payload = reply.payload;
        if (payload && typeof payload === 'object' && 'error' in (payload as Record<string, unknown>)) {
          return errorResult(
            `Delegated agent "${target.name}" returned error: ` +
            `${(payload as { error: string }).error}`,
          );
        }

        return textResult(
          typeof payload === 'string' ? payload : JSON.stringify(payload),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`delegate to "${target.name}" failed: ${msg}`);
      }
    },
  };

  if (!approvalGate) return toolDef;

  // Run the tool definition through the approval gate middleware.
  // The middleware's beforeExecution mutates the tools array in place,
  // returning a wrapped clone in slot 0.
  const gate = createApprovalGateMiddleware(approvalGate);
  const wrapper: { tools: ToolDefinition[] } = { tools: [toolDef] };
  gate.beforeExecution(wrapper);
  return wrapper.tools[0];
}

// ─── Subagent execution ─────────────────────────────────────────────────

async function executeSubagent(
  sa: Subagent,
  params: DelegateParams,
  ctx: import('@dongkseo/contracts').ToolContext,
  runtimeFactory?: SubagentRuntimeFactory,
  onEvent?: (name: string, event: AgentEvent) => void,
): Promise<ToolResult> {
  const relay = onEvent ? (e: AgentEvent) => onEvent(sa.name, e) : undefined;

  switch (sa.type) {
    case 'compiled':
      return runRuntime(sa.name, sa.runtime, params, relay);

    case 'declarative': {
      if (!runtimeFactory) {
        return errorResult(`Cannot run declarative subagent "${sa.name}": no runtimeFactory provided`);
      }
      return runRuntime(sa.name, await runtimeFactory(sa), params, relay);
    }

    case 'async': {
      try {
        const res = await fetch(sa.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...sa.headers },
          body: JSON.stringify({ input: params.input }),
          signal: AbortSignal.timeout(sa.timeoutMs ?? 300_000),
        });
        if (!res.ok) return errorResult(`async subagent "${sa.name}" returned ${res.status}`);
        const body = await res.text();
        return textResult(body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`async subagent "${sa.name}" failed: ${msg}`);
      }
    }
  }
}

async function runRuntime(
  name: string,
  runtime: AgentRuntime,
  params: DelegateParams,
  onEvent?: (event: AgentEvent) => void,
): Promise<ToolResult> {
  const { content, isError } = await drainRuntime(name, runtime, params.input, { onEvent });
  if (isError) return errorResult(`subagent "${name}": ${content}`);
  return textResult(content || '(no response)');
}

interface DrainOutcome {
  content: string;
  isError: boolean;
  timedOut: boolean;
}

/**
 * Drives an AgentRuntime to completion and returns its outcome. Shared core for
 * both the sync delegate path (runRuntime) and the background path
 * (pumpBackgroundChild). Applies NO content fallback — callers apply their own.
 * When opts.timeoutMs is set, a hung child is aborted and reported via timedOut.
 */
async function drainRuntime(
  name: string,
  runtime: AgentRuntime,
  input: unknown,
  opts: { onEvent?: (event: AgentEvent) => void; timeoutMs?: number } = {},
): Promise<DrainOutcome> {
  const agentInput: AgentInput = {
    prompt: typeof input === 'string' ? input : JSON.stringify(input),
  };

  let timedOut = false;
  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          runtime.abort();
        }, opts.timeoutMs)
      : null;
  timer?.unref?.();

  let content = '';
  let isError = false;
  try {
    for await (const event of runtime.execute(agentInput)) {
      opts.onEvent?.(event);
      if (event.type === 'done') content = event.content;
      else if (event.type === 'error') {
        content = event.message;
        isError = true;
      }
    }
  } catch (err) {
    content = err instanceof Error ? err.message : String(err);
    isError = true;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (timedOut) {
    content = `Background subagent "${name}" exceeded ${opts.timeoutMs}ms and was aborted.`;
    isError = true;
  }

  return { content, isError, timedOut };
}

// ─── Background subagent pump ───────────────────────────────────────────────

/**
 * Pumps a caller-owned background subagent's runtime to completion on a detached
 * loop, then delivers its result: into the parent's live turn via steerSelf, or
 * — if the parent turn already ended — through the deliverResult sink. A child
 * cancelled via cancel_subagent is settled but not delivered.
 */
async function pumpBackgroundChild(args: {
  jobId: string;
  childName: string;
  runtime: AgentRuntime;
  input: unknown;
  jobRegistry: BackgroundTaskRegistry;
  onSubagentEvent?: (name: string, event: AgentEvent) => void;
  steerSelf?: (message: string) => boolean;
  deliverResult?: (result: BackgroundTaskResult) => void | Promise<void>;
  logger: ToolLogger;
  timeoutMs?: number;
}): Promise<void> {
  const { jobId, childName, runtime, input, jobRegistry, onSubagentEvent, steerSelf, deliverResult, logger, timeoutMs } = args;

  // Drive the child runtime to completion. drainRuntime bounds a hung child via
  // timeoutMs (abort + `timedOut`), distinguishing that from normal completion
  // and from an explicit cancel_subagent.
  const { content, isError } = await drainRuntime(childName, runtime, input, {
    onEvent: onSubagentEvent ? (e) => onSubagentEvent(childName, e) : undefined,
    timeoutMs,
  });

  // settle() is a no-op if the job was already marked cancelled by cancel_subagent.
  jobRegistry.settle(jobId, isError ? 'error' : 'done', Date.now());
  if (jobRegistry.get(jobId)?.status === 'cancelled') return;

  const result: BackgroundTaskResult = { taskId: jobId, kind: 'subagent', label: childName, content: content || '(no output)', isError };
  const message = formatChildResult(result);

  // Fold into the parent's live turn; steerSelf returns false once that turn ends.
  if (steerSelf?.(message)) return;

  if (deliverResult) {
    try {
      await deliverResult(result);
    } catch (err) {
      logger.error('delegate.background.deliver_failed', {
        jobId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  logger.warn('delegate.background.result_dropped', {
    jobId,
    childName,
    reason: 'parent turn ended and no deliverResult sink configured',
  });
}

function formatChildResult(result: BackgroundTaskResult): string {
  const status = result.isError ? 'failed' : 'completed';
  return `[background subagent "${result.label}" ${status}] (job ${result.taskId})\n${result.content}`;
}
