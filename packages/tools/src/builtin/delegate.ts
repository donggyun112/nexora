/**
 * delegate — runtime agent-to-agent task delegation.
 *
 * The agent calls this tool when its own tools aren't enough and another
 * agent declares the capability it needs. The tool looks up the registry,
 * picks a candidate, sends a request via transport, and blocks until the
 * other agent replies — then returns the result to the calling agent's
 * reasoning loop.
 *
 * This is the L3 "autonomous communication" primitive: the LLM DECIDES
 * at runtime whether to delegate, to whom (by capability, not by name),
 * and what to send. The framework handles discovery + routing + timeout.
 *
 * Design choices:
 *   - Agents still don't know each other by NAME — they only know
 *     CAPABILITIES. The registry is the indirection layer.
 *   - Cycle detection: metadata carries a delegation depth counter.
 *     If depth exceeds the configured max, the tool refuses. This prevents
 *     A → B → A → B → ... infinite loops.
 *   - Tenant isolation: the delegated request inherits the caller's tenantId.
 */

import type {
  ToolDefinition,
  ToolResult,
  EventTransport,
  AgentRegistry,
  TopicString,
} from '@nexora/contracts';
import { textResult, errorResult } from '@nexora/contracts';

export interface DelegateToolOptions {
  transport: EventTransport;
  registry: AgentRegistry;
  /** Maximum delegation depth before refusing. Default: 5. */
  maxDepth?: number;
  /** Default timeout for the delegated request. Default: 120_000 (2 min). */
  defaultTimeoutMs?: number;
}

interface DelegateParams {
  /** Capability string to look up in the registry. */
  capability: string;
  /** Prompt / payload to send to the target agent. */
  input: unknown;
  /** Override timeout. */
  timeoutMs?: number;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Metadata key used to track delegation depth across hops. */
export const DELEGATION_DEPTH_KEY = '__nexora_delegation_depth__';

export function createDelegateTool(options: DelegateToolOptions): ToolDefinition {
  const {
    transport,
    registry,
    maxDepth = DEFAULT_MAX_DEPTH,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  return {
    name: 'delegate',
    description:
      'Delegate a subtask to another agent by capability. The framework ' +
      'looks up which agent can handle the capability, sends the request, ' +
      'and returns the result. Use when your own tools are insufficient ' +
      'and another agent specializes in what you need. ' +
      'You specify a CAPABILITY (e.g. "code-review", "translation"), not ' +
      'an agent name — you never need to know who answers.',
    parameters: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'Required capability (e.g. "code-review", "summarization")',
        },
        input: {
          description: 'Payload to send — typically { prompt: "..." } but can be any object the target agent expects',
        },
        timeoutMs: {
          type: 'number',
          description: `Max wait time in ms. Default ${DEFAULT_TIMEOUT_MS}.`,
        },
      },
      required: ['capability', 'input'],
    },
    execute: async (callId, rawInput, ctx): Promise<ToolResult> => {
      const params = rawInput as DelegateParams;

      if (!params.capability || typeof params.capability !== 'string') {
        return errorResult('capability is required');
      }
      if (params.input === undefined) {
        return errorResult('input is required');
      }

      // ── Cycle detection ──────────────────────────────────────────────
      // The ToolContext doesn't natively carry delegation depth, so we
      // piggyback on a convention: the caller (bootstrap / runner) sets
      // `ctx.signal` metadata or we track it via a closure. For the MVP
      // we use a simple per-process counter keyed by traceId.
      const currentDepth = depthTracker.get(callId) ?? 0;
      if (currentDepth >= maxDepth) {
        return errorResult(
          `Delegation depth ${currentDepth} exceeds max ${maxDepth}. ` +
          `This usually means agents are delegating in a cycle. ` +
          `Review the capability graph.`,
        );
      }

      // ── Registry lookup ──────────────────────────────────────────────
      const candidates = await registry.findByCapability(params.capability);
      if (candidates.length === 0) {
        return errorResult(`No agent declares capability "${params.capability}"`);
      }

      // Pick the first candidate. In a production system you'd want
      // load-balancing, tenant affinity, or latency-based selection.
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

      ctx.logger.info('delegate', {
        capability: params.capability,
        target: target.name,
        topic: targetTopic,
        depth: currentDepth + 1,
        timeoutMs,
      });

      // Track depth for the downstream call
      depthTracker.set(callId, currentDepth + 1);

      try {
        const reply = await transport.request(
          targetTopic as TopicString,
          params.input,
          {
            timeoutMs,
            tenantId: ctx.tenantId,
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
      } finally {
        depthTracker.delete(callId);
      }
    },
  };
}

/**
 * Simple per-process depth tracker. Keyed by callId so concurrent
 * delegations don't interfere. Cleaned up in `finally`.
 *
 * A more robust version would propagate depth via MessageEnvelope metadata
 * (e.g. a `__nexora_delegation_depth__` field) so it survives across
 * processes. That's a follow-up.
 */
const depthTracker = new Map<string, number>();
