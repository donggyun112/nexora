/**
 * OTel Agent Middleware — per-execution span isolation via AsyncLocalStorage.
 *
 * M1 FIX: previous versions used shared state (stack, WeakMap + lastExecutionSpan)
 * that wasn't concurrent-safe for tool span parenting. Now uses AsyncLocalStorage
 * so each execution's context is fully isolated from concurrent runs.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
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

interface ExecutionContext {
  executionSpan: Span;
}

/**
 * Per-execution span storage. beforeExecution sets it, afterExecution clears it,
 * and beforeToolCall reads it. AsyncLocalStorage ensures concurrent executions
 * each see their own span without interference.
 */
const executionStorage = new AsyncLocalStorage<ExecutionContext>();

export function createOTelAgentMiddleware(
  options: OTelAgentMiddlewareOptions = {},
): AgentMiddleware & { name: string } {
  const tracer = options.tracer ?? trace.getTracer('nexora');
  const defaultAttrs = options.defaultAttributes ?? {};
  const toolSpans = new Map<string, Span>();

  // Fallback for environments where AsyncLocalStorage doesn't propagate
  // (e.g. test mocks that call before/afterExecution synchronously).
  let fallbackSpan: Span | null = null;

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
      fallbackSpan = span;

      // Enter the execution context. The MiddlewarePipeline calls
      // the agent loop within the same async context, so tool calls
      // issued during this execution will inherit this storage.
      executionStorage.enterWith({ executionSpan: span });
    },

    afterExecution(ctx: { events: unknown[]; finalContent: string; error?: Error; input: unknown }): void {
      const execCtx = executionStorage.getStore();
      const span = execCtx?.executionSpan ?? fallbackSpan;
      if (!span) return;

      fallbackSpan = null;

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
      // M1 FIX: get the execution span from AsyncLocalStorage, not shared state
      const execCtx = executionStorage.getStore();
      const parentSpan = execCtx?.executionSpan ?? fallbackSpan;
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
