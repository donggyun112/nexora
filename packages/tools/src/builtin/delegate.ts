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
  EventTransport,
  AgentRegistry,
  AgentRuntime,
  AgentInput,
  AgentEvent,
  TopicString,
  MessageEnvelope,
} from '@nexora/contracts';
import {
  textResult,
  errorResult,
  messageId,
  traceId,
  spanId,
  conversationId,
} from '@nexora/contracts';
import { createApprovalGateMiddleware } from '../handraise/approval-middleware.js';
import type { ApprovalGateOptions } from '../handraise/approval-middleware.js';

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
  } = options;

  // Index inline subagents by name for O(1) lookup
  const subagentsByName = new Map<string, Subagent>();
  for (const sa of subagents) {
    subagentsByName.set(sa.name, sa);
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
            'Result handling. "sync" (default): wait for reply this turn. ' +
            'false: fire-and-forget, no result returned. ' +
            '"async": spawn thread, result arrives in a later turn (not yet implemented).',
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
  ctx: import('@nexora/contracts').ToolContext,
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
  const input: AgentInput = {
    prompt: typeof params.input === 'string' ? params.input : JSON.stringify(params.input),
  };
  let content = '';
  for await (const event of runtime.execute(input)) {
    onEvent?.(event);
    if (event.type === 'done') content = event.content;
    else if (event.type === 'error') return errorResult(`subagent "${name}": ${event.message}`);
  }
  return textResult(content || '(no response)');
}
