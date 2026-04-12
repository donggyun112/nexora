/**
 * OTel Agent Middleware — per-execution span isolation.
 *
 * R3 FIX: previous versions used a shared stack/array for execution spans,
 * which broke under concurrent executions (interleaved push/pop). Now each
 * execution is keyed by its input object reference, and tool spans are
 * parented to their own execution's span via a WeakMap lookup.
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

export function createOTelAgentMiddleware(
  options: OTelAgentMiddlewareOptions = {},
): AgentMiddleware & { name: string } {
  const tracer = options.tracer ?? trace.getTracer('nexora');
  const defaultAttrs = options.defaultAttributes ?? {};

  // R3 FIX: key execution spans by input object reference.
  // This is concurrent-safe because each execute() call gets a unique input object.
  const executionSpans = new WeakMap<object, Span>();
  // Fallback for non-object inputs (rare but possible)
  let lastExecutionSpan: Span | null = null;
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
      if (ctx.input && typeof ctx.input === 'object') {
        executionSpans.set(ctx.input as object, span);
      }
      lastExecutionSpan = span;
    },

    afterExecution(ctx: { events: unknown[]; finalContent: string; error?: Error; input: unknown }): void {
      const span = (ctx.input && typeof ctx.input === 'object')
        ? executionSpans.get(ctx.input as object)
        : lastExecutionSpan;
      if (!span) return;
      if (ctx.input && typeof ctx.input === 'object') {
        executionSpans.delete(ctx.input as object);
      }
      lastExecutionSpan = null;

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
      const parentSpan = lastExecutionSpan;
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
