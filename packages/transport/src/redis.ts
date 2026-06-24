/**
 * RedisTransport — Redis PUBSUB adapter.
 *
 * DELIVERY CONTRACT: at-most-once, non-durable. Redis pub/sub is fire-and-forget:
 * if no subscriber is listening when the message is published, the message is
 * dropped. This transport implements `EventTransport` ONLY. For production
 * workflow steps or critical paths, use `RedisStreamsTransport` (at-least-once
 * with consumer groups) or another `DurableTransport` impl.
 *
 * Do NOT assume this is "production-grade just because it's Redis". Pub/sub
 * in Redis has the same delivery guarantees as LocalTransport — it's just
 * distributed across processes.
 *
 * Uses Redis pattern subscription (PSUBSCRIBE) for wildcard topic matching.
 *
 * Usage:
 *   import { Redis } from 'ioredis';
 *   const sub = new Redis();
 *   const pub = new Redis();
 *   const transport = new RedisTransport({ subscriber: sub, publisher: pub });
 */

import type {
  EventTransport,
  Subscription,
  RequestOptions,
  MessageEnvelope,
  TopicString,
  TransportDescription,
} from '@dongkseo/contracts';
import { matchTopic, messageId, traceId, spanId, conversationId } from '@dongkseo/contracts';

/**
 * Redis 클라이언트가 구현해야 할 최소 인터페이스.
 * `ioredis`, `redis@4` 모두 호환.
 */
export interface RedisLike {
  publish(channel: string, message: string): Promise<number> | number;
  psubscribe?(pattern: string): Promise<unknown> | unknown;
  punsubscribe?(pattern?: string): Promise<unknown> | unknown;
  on(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): unknown;
  off?(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): unknown;
  removeListener?(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): unknown;
  quit?(): Promise<unknown> | unknown;
}

export interface RedisTransportOptions {
  /** subscribe 전용 클라이언트 (중요: pub/sub 분리) */
  subscriber: RedisLike;
  /** publish 전용 클라이언트 */
  publisher: RedisLike;
  /** 채널 prefix (멀티 환경 분리, 기본 'nexora') */
  channelPrefix?: string;
  /** 기본 request timeout (ms, 기본 30000) */
  defaultRequestTimeoutMs?: number;
}

interface SubRecord {
  pattern: string;
  handler: (envelope: MessageEnvelope) => Promise<void>;
}

export class RedisTransport implements EventTransport {
  private readonly subscriber: RedisLike;
  private readonly publisher: RedisLike;
  private readonly prefix: string;
  private readonly subscribers = new Map<number, SubRecord>();
  private nextId = 0;
  private closed = false;
  private readonly defaultRequestTimeoutMs: number;
  private psubscribed = false;

  constructor(options: RedisTransportOptions) {
    this.subscriber = options.subscriber;
    this.publisher = options.publisher;
    this.prefix = options.channelPrefix ?? 'nexora';
    this.defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? 30_000;

    this.subscriber.on('pmessage', (_pat, channel, message) => {
      this.handlePMessage(channel, message);
    });
  }

  describe(): TransportDescription {
    return {
      kind: 'redis-pubsub',
      deliveryGuarantee: 'at-most-once',
      durable: false,
      supportsConsumerGroups: false,
      notes: `Redis PUBSUB (prefix: ${this.prefix}). No durability: if no subscriber is connected at publish time, the message is lost. For at-least-once delivery use a DurableTransport implementation.`,
    };
  }

  private channelFor(topic: string): string {
    return `${this.prefix}:${topic}`;
  }

  private async ensurePSubscribed(): Promise<void> {
    if (this.psubscribed) return;
    if (!this.subscriber.psubscribe) {
      throw new Error('Redis client does not support psubscribe');
    }
    await this.subscriber.psubscribe(`${this.prefix}:*`);
    this.psubscribed = true;
  }

  async publish(envelope: MessageEnvelope): Promise<void> {
    if (this.closed) throw new Error('RedisTransport is closed');
    const channel = this.channelFor(envelope.topic);
    await this.publisher.publish(channel, JSON.stringify(envelope));
  }

  subscribe(
    pattern: string,
    handler: (envelope: MessageEnvelope) => Promise<void>,
  ): Subscription {
    if (this.closed) throw new Error('RedisTransport is closed');
    const id = this.nextId++;
    this.subscribers.set(id, { pattern, handler });
    void this.ensurePSubscribed();
    return {
      unsubscribe: () => {
        this.subscribers.delete(id);
      },
    };
  }

  async request(
    topic: TopicString,
    payload: unknown,
    options?: RequestOptions,
  ): Promise<MessageEnvelope> {
    if (this.closed) throw new Error('RedisTransport is closed');

    const requestId = messageId();
    const timeoutMs = options?.timeoutMs ?? this.defaultRequestTimeoutMs;

    const envelope: MessageEnvelope = {
      id: requestId,
      topic,
      type: 'request',
      payload,
      metadata: {
        traceId: options?.traceId ?? traceId(),
        spanId: spanId(),
        conversationId: options?.conversationId ?? conversationId(),
        tenantId: options?.tenantId ?? 'default',
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
        reject(new Error(`Redis request to ${topic} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      void this.publish(envelope);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscribers.clear();
    if (this.subscriber.punsubscribe) {
      try {
        await this.subscriber.punsubscribe();
      } catch {
        // ignore
      }
    }
  }

  private handlePMessage(channel: string, message: string): void {
    if (!channel.startsWith(`${this.prefix}:`)) return;
    const topic = channel.slice(this.prefix.length + 1) as TopicString;

    let envelope: MessageEnvelope;
    try {
      envelope = JSON.parse(message) as MessageEnvelope;
    } catch {
      return;
    }

    for (const sub of this.subscribers.values()) {
      if (matchTopic(sub.pattern, topic)) {
        sub.handler(envelope).catch(err => {
          console.error('[RedisTransport] handler error', { topic, err });
        });
      }
    }
  }
}
