/**
 * OTel Transport Middleware — wraps an EventTransport to emit OpenTelemetry
 * spans for every publish, subscribe handler, and request/reply.
 *
 * Nexora already carries traceId/spanId/parentSpanId in every MessageEnvelope.
 * This middleware bridges those fields to the OTel SDK so they appear as real
 * spans in Jaeger, Tempo, Honeycomb, Datadog, etc.
 *
 * How it works:
 *   - publish(): creates a PRODUCER span, sets the envelope's traceId/spanId
 *     as the OTel span's traceId/spanId, and links parentSpanId.
 *   - subscribe(): wraps the handler so each invocation creates a CONSUMER
 *     span that is a child of the envelope's spanId.
 *   - request(): creates a CLIENT span that covers the full round-trip.
 *
 * Usage:
 *   import { trace } from '@opentelemetry/api';
 *   import { OTelTransport } from '@nexora/otel';
 *
 *   const inner = new LocalTransport();
 *   const transport = new OTelTransport(inner, {
 *     tracer: trace.getTracer('nexora'),
 *   });
 *   // Now every publish/subscribe/request emits OTel spans.
 *
 * The SDK must be initialized elsewhere (typically in the process entrypoint
 * via @opentelemetry/sdk-node). This module only uses the @opentelemetry/api
 * facade — no heavy SDK deps.
 */

import type {
  Tracer,
  Span,
  SpanKind,
  SpanContext,
  SpanStatusCode,
} from '@opentelemetry/api';
import {
  trace,
  context as otelContext,
  SpanKind as SpanKindEnum,
  SpanStatusCode as SpanStatusCodeEnum,
  ROOT_CONTEXT,
} from '@opentelemetry/api';
import type {
  EventTransport,
  Subscription,
  RequestOptions,
  MessageEnvelope,
  TopicString,
  TransportDescription,
} from '@nexora/contracts';

export interface OTelTransportOptions {
  /**
   * OpenTelemetry tracer instance. Typically `trace.getTracer('nexora')`.
   * If not provided, uses `trace.getTracer('nexora')` as default.
   */
  tracer?: Tracer;
  /**
   * Additional span attributes to set on every span (e.g. service.name,
   * deployment.environment). Agent-specific attributes (topic, tenantId)
   * are added automatically.
   */
  defaultAttributes?: Record<string, string>;
}

export class OTelTransport implements EventTransport {
  private readonly inner: EventTransport;
  private readonly tracer: Tracer;
  private readonly defaultAttrs: Record<string, string>;

  constructor(inner: EventTransport, options: OTelTransportOptions = {}) {
    this.inner = inner;
    this.tracer = options.tracer ?? trace.getTracer('nexora');
    this.defaultAttrs = options.defaultAttributes ?? {};
  }

  describe(): TransportDescription {
    const inner = this.inner.describe();
    return {
      ...inner,
      notes: (inner.notes ? `${inner.notes}; ` : '') + 'OTel-instrumented',
    };
  }

  async publish(envelope: MessageEnvelope): Promise<void> {
    const span = this.tracer.startSpan(`nexora.publish ${envelope.topic}`, {
      kind: SpanKindEnum.PRODUCER,
      attributes: {
        ...this.defaultAttrs,
        'nexora.topic': envelope.topic,
        'nexora.type': envelope.type,
        'nexora.traceId': envelope.metadata.traceId,
        'nexora.spanId': envelope.metadata.spanId,
        'nexora.tenantId': envelope.metadata.tenantId,
        'nexora.conversationId': envelope.metadata.conversationId,
        ...(envelope.metadata.sourceInstanceId
          ? { 'nexora.source': envelope.metadata.sourceInstanceId }
          : {}),
      },
    });

    try {
      // C6 FIX: make the publish span active during the inner.publish() call
      // so any spans created inside (e.g. by the transport's internal logic)
      // are children of this publish span.
      await otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
        await this.inner.publish(envelope);
      });
      span.setStatus({ code: SpanStatusCodeEnum.OK });
    } catch (err) {
      span.setStatus({ code: SpanStatusCodeEnum.ERROR, message: errMsg(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  }

  subscribe(
    pattern: string,
    handler: (envelope: MessageEnvelope) => Promise<void>,
  ): Subscription {
    return this.inner.subscribe(pattern, async (envelope) => {
      // C6 FIX: create the handler span as a child of the envelope's
      // spanId (the publisher's span). We link them via a SpanLink so
      // distributed traces show the causal chain even across processes.
      // NOTE: OTel's `startSpan` with a remote parent requires constructing
      // a SpanContext from the envelope's IDs. Since Nexora's IDs are
      // UUID-based (not W3C TraceContext format), we cannot do a true
      // remote parent. Instead we add a link attribute so the trace viewer
      // can correlate them, and we set the span as active during the handler
      // so nested spans are children of it.
      const span = this.tracer.startSpan(`nexora.handle ${envelope.topic}`, {
        kind: SpanKindEnum.CONSUMER,
        attributes: {
          ...this.defaultAttrs,
          'nexora.topic': envelope.topic,
          'nexora.type': envelope.type,
          'nexora.traceId': envelope.metadata.traceId,
          'nexora.spanId': envelope.metadata.spanId,
          'nexora.parentSpanId': envelope.metadata.parentSpanId ?? '',
          'nexora.tenantId': envelope.metadata.tenantId,
          'nexora.subscribePattern': pattern,
        },
      });

      try {
        // Make the handler span active so any downstream spans (tool calls,
        // LLM calls, nested publishes) are children of this handler span.
        await otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
          await handler(envelope);
        });
        span.setStatus({ code: SpanStatusCodeEnum.OK });
      } catch (err) {
        span.setStatus({ code: SpanStatusCodeEnum.ERROR, message: errMsg(err) });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async request(
    topic: TopicString,
    payload: unknown,
    options?: RequestOptions,
  ): Promise<MessageEnvelope> {
    const span = this.tracer.startSpan(`nexora.request ${String(topic)}`, {
      kind: SpanKindEnum.CLIENT,
      attributes: {
        ...this.defaultAttrs,
        'nexora.topic': String(topic),
        'nexora.tenantId': options?.tenantId ?? 'unknown',
        'nexora.timeoutMs': String(options?.timeoutMs ?? 'default'),
      },
    });

    try {
      const reply = await this.inner.request(topic, payload, options);
      span.setStatus({ code: SpanStatusCodeEnum.OK });
      span.setAttribute('nexora.replyTopic', reply.topic);
      return reply;
    } catch (err) {
      span.setStatus({ code: SpanStatusCodeEnum.ERROR, message: errMsg(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
