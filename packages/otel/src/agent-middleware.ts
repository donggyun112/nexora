/**
 * OTel Agent Middleware — emits spans for agent execution, tool calls, and
 * LLM invocations. Plugs into Nexora's MiddlewarePipeline so every agent
 * automatically gets traced.
 *
 * Usage:
 *   import { createOTelAgentMiddleware } from '@nexora/otel';
 *   import { trace } from '@opentelemetry/api';
 *
 *   const runner = new AgentRunner({
 *     ...
 *     middlewares: [createOTelAgentMiddleware(trace.getTracer('nexora'))],
 *   });
 */

import type { Tracer, Span } from '@opentelemetry/api';
import {
  trace,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';
// Middleware types are defined in @nexora/core, but we don't want otel to
// depend on the entire core package. These minimal inline types match the
// subset that the OTel middleware actually uses.
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

export function createOTelAgentMiddleware(
  options: OTelAgentMiddlewareOptions = {},
): AgentMiddleware & { name: string } {
  const tracer = options.tracer ?? trace.getTracer('nexora');
  const defaultAttrs = options.defaultAttributes ?? {};
  let executionSpan: Span | null = null;
  const toolSpans = new Map<string, Span>();

  return {
    name: 'otel',

    beforeExecution(ctx: { tools: unknown[]; systemPrompt: string; input: unknown }): void {
      executionSpan = tracer.startSpan('nexora.agent.execute', {
        kind: SpanKind.INTERNAL,
        attributes: {
          ...defaultAttrs,
          'nexora.agent.tools': String(ctx.tools.length),
        },
      });
    },

    afterExecution(ctx: { events: unknown[]; finalContent: string; error?: Error; input: unknown }): void {
      if (!executionSpan) return;
      executionSpan.setAttribute('nexora.agent.events', ctx.events.length);
      if (ctx.error) {
        executionSpan.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error.message });
        executionSpan.recordException(ctx.error);
      } else {
        executionSpan.setStatus({ code: SpanStatusCode.OK });
      }
      executionSpan.end();
      executionSpan = null;
    },

    beforeToolCall(ctx: { toolName: string; callId: string; input: unknown; tool: unknown }): void {
      const span = tracer.startSpan(`nexora.tool.${ctx.toolName}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          ...defaultAttrs,
          'nexora.tool.name': ctx.toolName,
          'nexora.tool.callId': ctx.callId,
        },
      });
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
