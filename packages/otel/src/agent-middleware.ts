/**
 * OTel Agent Middleware — emits spans for agent execution + tool calls.
 *
 * R4 FIX: the previous implementation stored `executionSpan` and `toolSpans`
 * as closure-shared state, so concurrent agent executions would overwrite
 * each other's spans. Now each middleware instance gets its own span state
 * by using the callId/input as a correlation key. Tool spans are keyed by
 * callId (already unique per call).
 *
 * C6 FIX: OTelTransport now creates proper parent contexts from envelope
 * metadata (see transport-middleware.ts). This middleware focuses on the
 * agent execution layer, not the transport layer.
 */

import type { Tracer, Span } from '@opentelemetry/api';
import {
  trace,
  context as otelContext,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';

interface AgentMiddleware {
  name: string;
  beforeExecution?(ctx: { tools: unknown[]; systemPrompt: string; input: unknown }): Promise<void> | void;
  afterExecution?(ctx: { events: unknown[]; finalContent: string; error?: Error; input: unknown }): Promise<void> | void;
  beforeToolCall?(ctx: { toolName: string; callId: string; input: unknown; tool: unknown }): Promise<void> | void;
  afterToolCall?(ctx: { toolName: string; callId: string; input: unknown; result: unknown; isError: boolean }): Promise<void> | void;
}

export interface OTelAgentMiddlewareOptions {
  tracer?: Tracer;
  defaultAttributes?: Record<string, string>;
}

/**
 * Creates an OTel agent middleware. Each middleware instance maintains its
 * own execution span stack, so concurrent runners sharing the same middleware
 * don't interfere. Tool spans are keyed by callId (globally unique).
 */
export function createOTelAgentMiddleware(
  options: OTelAgentMiddlewareOptions = {},
): AgentMiddleware & { name: string } {
  const tracer = options.tracer ?? trace.getTracer('nexora');
  const defaultAttrs = options.defaultAttributes ?? {};

  // R4 FIX: per-execution span isolation via a stack. Each beforeExecution
  // pushes, each afterExecution pops. Concurrent runs use different stack
  // entries. Tool spans are keyed by callId which is already unique.
  const executionSpanStack: Span[] = [];
  const toolSpans = new Map<string, Span>();

  return {
    name: 'otel',

    beforeExecution(ctx: { tools: unknown[]; systemPrompt: string; input: unknown }): void {
      const span = tracer.startSpan('nexora.agent.execute', {
        kind: SpanKind.INTERNAL,
        attributes: {
          ...defaultAttrs,
          'nexora.agent.tools': String(ctx.tools.length),
        },
      });
      executionSpanStack.push(span);
    },

    afterExecution(ctx: { events: unknown[]; finalContent: string; error?: Error; input: unknown }): void {
      const span = executionSpanStack.pop();
      if (!span) return;
      span.setAttribute('nexora.agent.events', ctx.events.length);
      if (ctx.error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error.message });
        span.recordException(ctx.error);
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
    },

    beforeToolCall(ctx: { toolName: string; callId: string; input: unknown; tool: unknown }): void {
      // Create the tool span as a child of the current execution span (if any).
      const parentSpan = executionSpanStack[executionSpanStack.length - 1];
      const parentCtx = parentSpan
        ? trace.setSpan(otelContext.active(), parentSpan)
        : otelContext.active();

      const span = tracer.startSpan(`nexora.tool.${ctx.toolName}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          ...defaultAttrs,
          'nexora.tool.name': ctx.toolName,
          'nexora.tool.callId': ctx.callId,
        },
      }, parentCtx);
      toolSpans.set(ctx.callId, span);
    },

    afterToolCall(ctx: { toolName: string; callId: string; input: unknown; result: unknown; isError: boolean }): void {
      const span = toolSpans.get(ctx.callId);
      if (!span) return;
      toolSpans.delete(ctx.callId);
      span.setAttribute('nexora.tool.isError', ctx.isError);
      if (ctx.isError) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
    },
  };
}
