/**
 * LocalTransport — in-process EventEmitter-backed transport.
 *
 * DELIVERY CONTRACT: at-most-once, non-durable. This is the weakest
 * guarantee — messages are dispatched via setImmediate to current
 * subscribers and then forgotten. If no subscriber is listening, the
 * message is lost. If a subscriber's handler throws, there is no retry.
 * This transport implements `EventTransport` explicitly and does NOT
 * implement `DurableTransport`.
 *
 * Use for: development, unit tests, single-process demos.
 * Do NOT use for: workflow engine steps, billable work, anything that
 * must be processed exactly once. For those, use a DurableTransport
 * implementation (RedisStreamsTransport, planned).
 *
 * Topic pattern matching: `*` matches a single segment, `#` matches the rest.
 */

import { EventEmitter } from 'node:events';
import type {
  EventTransport,
  Subscription,
  RequestOptions,
  MessageEnvelope,
  TopicString,
  MessageMetadata,
  TransportDescription,
} from '@nexora/contracts';
import { matchTopic, messageId, traceId, spanId, conversationId } from '@nexora/contracts';

interface SubscriberRecord {
  pattern: string;
  handler: (envelope: MessageEnvelope) => Promise<void>;
  id: number;
}

const PUBLISH_EVENT = '__nexora_publish__';

export interface LocalTransportOptions {
  /** 핸들러 에러 시 호출 (기본: console.error) */
  onHandlerError?: (err: unknown, envelope: MessageEnvelope) => void;
  /** 기본 request timeout (ms, 기본 30000) */
  defaultRequestTimeoutMs?: number;
}

export class LocalTransport implements EventTransport {
  private readonly emitter = new EventEmitter();
  private readonly subscribers = new Map<number, SubscriberRecord>();
  private nextId = 0;
  private closed = false;
  private readonly onHandlerError: NonNullable<LocalTransportOptions['onHandlerError']>;
  private readonly defaultRequestTimeoutMs: number;

  constructor(options: LocalTransportOptions = {}) {
    this.emitter.setMaxListeners(0);
    this.onHandlerError = options.onHandlerError ?? ((err, env) => {
      console.error('[LocalTransport] handler error', { topic: env.topic, err });
    });
    this.defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? 30_000;

    this.emitter.on(PUBLISH_EVENT, (envelope: MessageEnvelope) => {
      void this.dispatch(envelope);
    });
  }

  describe(): TransportDescription {
    return {
      kind: 'local',
      deliveryGuarantee: 'at-most-once',
      durable: false,
      supportsConsumerGroups: false,
      notes: 'In-process EventEmitter. Dev/test only. Messages are dropped if no subscriber is listening.',
    };
  }

  async publish(envelope: MessageEnvelope): Promise<void> {
    if (this.closed) throw new Error('LocalTransport is closed');
    // 비동기 dispatch — publish는 즉시 반환
    setImmediate(() => this.emitter.emit(PUBLISH_EVENT, envelope));
  }

  subscribe(
    pattern: string,
    handler: (envelope: MessageEnvelope) => Promise<void>,
  ): Subscription {
    if (this.closed) throw new Error('LocalTransport is closed');
    const id = this.nextId++;
    this.subscribers.set(id, { pattern, handler, id });
    return {
      unsubscribe: () => {
        this.subscribers.delete(id);
      },
    };
  }

  /**
   * Request-reply: 임시 reply topic 구독, request 발행, 단일 응답 대기.
   * 응답은 metadata.replyTo로 매칭.
   */
  async request(
    topic: TopicString,
    payload: unknown,
    options?: RequestOptions,
  ): Promise<MessageEnvelope> {
    if (this.closed) throw new Error('LocalTransport is closed');

    const requestId = messageId();
    const timeoutMs = options?.timeoutMs ?? this.defaultRequestTimeoutMs;

    const tid = options?.traceId ?? traceId();
    const sid = spanId();
    const cid = options?.conversationId ?? conversationId();
    const tenantId = options?.tenantId ?? 'default';

    const envelope: MessageEnvelope = {
      id: requestId,
      topic,
      type: 'request',
      payload,
      metadata: {
        traceId: tid,
        spanId: sid,
        conversationId: cid,
        tenantId,
        timestamp: Date.now(),
        // C3 FIX: propagate delegation metadata into the envelope
        delegationDepth: options?.delegationDepth,
        callerAgent: options?.callerAgent,
      },
    };

    return new Promise<MessageEnvelope>((resolve, reject) => {
      let resolved = false;

      const subscription = this.subscribe('#', async (incoming) => {
        if (resolved) return;
        if (incoming.metadata.replyTo === requestId) {
          resolved = true;
          subscription.unsubscribe();
          clearTimeout(timer);
          resolve(incoming);
        }
      });

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        subscription.unsubscribe();
        reject(new Error(`Request to ${topic} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      void this.publish(envelope);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscribers.clear();
    this.emitter.removeAllListeners();
  }

  /** 디버그용 — 현재 구독자 수 */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  private async dispatch(envelope: MessageEnvelope): Promise<void> {
    const matched: SubscriberRecord[] = [];
    for (const sub of this.subscribers.values()) {
      if (matchTopic(sub.pattern, envelope.topic as TopicString)) {
        matched.push(sub);
      }
    }

    await Promise.all(
      matched.map(async (sub) => {
        try {
          await sub.handler(envelope);
        } catch (err) {
          this.onHandlerError(err, envelope);
        }
      }),
    );
  }
}

/**
 * MessageEnvelope 생성 헬퍼 (신규 발행용).
 * 분산 추적 메타데이터 자동 채움.
 */
export function createEnvelope<T>(args: {
  topic: TopicString | string;
  payload: T;
  type?: MessageEnvelope['type'];
  metadata?: Partial<MessageMetadata>;
}): MessageEnvelope<T> {
  const md = args.metadata ?? {};
  return {
    id: messageId(),
    topic: args.topic,
    type: args.type ?? 'request',
    payload: args.payload,
    metadata: {
      traceId: md.traceId ?? traceId(),
      spanId: md.spanId ?? spanId(),
      parentSpanId: md.parentSpanId,
      conversationId: md.conversationId ?? conversationId(),
      replyTo: md.replyTo,
      tenantId: md.tenantId ?? 'default',
      sourceInstanceId: md.sourceInstanceId,
      timestamp: md.timestamp ?? Date.now(),
    },
  };
}
