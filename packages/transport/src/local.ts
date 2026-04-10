/**
 * LocalTransport — 인메모리 EventEmitter 기반 transport.
 *
 * 개발/테스트용. 단일 프로세스 내 에이전트 간 통신.
 * topic 패턴 매칭 (* 단일 세그먼트, # 나머지 전부) 지원.
 *
 * 같은 인터페이스를 만족하는 RedisTransport로 프로덕션 교체 가능.
 */

import { EventEmitter } from 'node:events';
import type {
  Transport,
  Subscription,
  RequestOptions,
  MessageEnvelope,
  TopicString,
  MessageMetadata,
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

export class LocalTransport implements Transport {
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
