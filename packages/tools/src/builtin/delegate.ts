/**
 * delegate — runtime agent-to-agent task delegation.
 *
 * The agent calls this tool when its own tools aren't enough and another
 * agent declares the capability it needs.
 *
 * C3 FIX: cycle detection now propagates via `metadata.delegationDepth` in
 * the MessageEnvelope so it works across processes. The old per-callId Map
 * was process-local and couldn't detect A→B→A cycles spanning two hosts.
 *
 * C2 FIX: the delegate tool now sets `metadata.callerAgent` so the receiving
 * bootstrap can enforce per-capability ACLs. Without this, any agent with
 * the delegate tool could invoke any advertised capability (confused deputy).
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
  /** This agent's name — propagated as callerAgent for auth. */
  callerAgentName: string;
  /** Maximum delegation depth before refusing. Default: 5. */
  maxDepth?: number;
  /** Default timeout for the delegated request. Default: 120_000 (2 min). */
  defaultTimeoutMs?: number;
  /**
   * Current delegation depth inherited from the envelope that triggered this
   * agent. Set by bootstrap from `envelope.metadata.delegationDepth`.
   * Defaults to 0 (first hop).
   */
  currentDepth?: number;
}

interface DelegateParams {
  capability: string;
  input: unknown;
  timeoutMs?: number;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_TIMEOUT_MS = 120_000;

export function createDelegateTool(options: DelegateToolOptions): ToolDefinition {
  const {
    transport,
    registry,
    callerAgentName,
    maxDepth = DEFAULT_MAX_DEPTH,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    currentDepth = 0,
  } = options;

  return {
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
          description: `Max wait time in ms. Default ${DEFAULT_TIMEOUT_MS}.`,
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

      // C3 FIX: check depth from envelope metadata (propagated across hops),
      // NOT from a process-local Map.
      const nextDepth = currentDepth + 1;
      if (nextDepth > maxDepth) {
        return errorResult(
          `Delegation depth ${nextDepth} exceeds max ${maxDepth}. ` +
          `This usually means agents are delegating in a cycle. ` +
          `Review the capability graph.`,
        );
      }

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

      ctx.logger.info('delegate', {
        capability: params.capability,
        target: target.name,
        topic: targetTopic,
        depth: nextDepth,
        caller: callerAgentName,
        timeoutMs,
      });

      try {
        // C3 + C2: propagate depth + caller identity in request options.
        // These flow into the MessageEnvelope.metadata on the transport side.
        // The receiving bootstrap reads them and can: (1) refuse if depth is
        // too high, (2) check if callerAgent is allowed to invoke the capability.
        //
        // NOTE: transport.request() puts traceId/tenantId/conversationId into
        // metadata. We need delegationDepth and callerAgent to also land there.
        // Since RequestOptions doesn't have these fields, we pass them as part
        // of the payload wrapper. The receiving bootstrap extracts them.
        const delegationPayload = {
          ...((typeof params.input === 'object' && params.input !== null) ? params.input : { _input: params.input }),
          __nexora_delegation__: {
            depth: nextDepth,
            caller: callerAgentName,
            capability: params.capability,
          },
        };

        const reply = await transport.request(
          targetTopic as TopicString,
          delegationPayload,
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
      }
    },
  };
}
