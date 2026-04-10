/**
 * Tracing — traceId/spanId 자동 전파.
 *
 * Transport를 wrap하여 publish 시 부모 span을 추적.
 * AsyncLocalStorage 기반 — 핸들러 안에서 발행하면 자동으로 parentSpanId 설정.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  EventTransport,
  MessageEnvelope,
  Subscription,
  RequestOptions,
  TopicString,
  TransportDescription,
} from '@nexora/contracts';
import { spanId } from '@nexora/contracts';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  conversationId: string;
  tenantId: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/** 현재 실행 컨텍스트의 trace 정보 (없으면 undefined) */
export function currentTrace(): TraceContext | undefined {
  return traceStorage.getStore();
}

/** 새 trace 컨텍스트로 함수 실행 */
export function withTrace<T>(ctx: TraceContext, fn: () => T): T {
  return traceStorage.run(ctx, fn);
}

/**
 * Transport를 wrap — publish/request에 자동으로 trace 정보 주입,
 * subscribe handler 실행 시 trace 컨텍스트 활성화.
 */
export class TracingTransport implements EventTransport {
  constructor(private readonly inner: EventTransport) {}

  describe(): TransportDescription {
    // Trace wrapping does not change delivery semantics — just annotate
    // the inner transport's description.
    const inner = this.inner.describe();
    return {
      ...inner,
      notes: (inner.notes ? `${inner.notes}; ` : '') + 'wrapped with TracingTransport',
    };
  }

  async publish(envelope: MessageEnvelope): Promise<void> {
    const trace = currentTrace();
    if (trace) {
      // 핸들러 안에서의 publish는 부모 trace를 항상 상속.
      // (createEnvelope이 새 traceId를 만들었더라도 덮어씀 — nested 호출은
      //  같은 trace로 묶여야 분산 추적이 의미를 가진다)
      envelope = {
        ...envelope,
        metadata: {
          ...envelope.metadata,
          traceId: trace.traceId,
          parentSpanId: envelope.metadata.parentSpanId ?? trace.spanId,
          conversationId: trace.conversationId,
          tenantId: trace.tenantId,
        },
      };
    }
    return this.inner.publish(envelope);
  }

  subscribe(
    pattern: string,
    handler: (envelope: MessageEnvelope) => Promise<void>,
  ): Subscription {
    return this.inner.subscribe(pattern, async (envelope) => {
      const ctx: TraceContext = {
        traceId: envelope.metadata.traceId,
        spanId: spanId(), // 새 span — 핸들러는 새 작업 단위
        parentSpanId: envelope.metadata.spanId,
        conversationId: envelope.metadata.conversationId,
        tenantId: envelope.metadata.tenantId,
      };
      await traceStorage.run(ctx, async () => {
        await handler(envelope);
      });
    });
  }

  async request(
    topic: TopicString,
    payload: unknown,
    options?: RequestOptions,
  ): Promise<MessageEnvelope> {
    const trace = currentTrace();
    return this.inner.request(topic, payload, {
      ...options,
      traceId: options?.traceId ?? trace?.traceId,
      conversationId: options?.conversationId ?? trace?.conversationId,
      tenantId: options?.tenantId ?? trace?.tenantId,
    });
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
