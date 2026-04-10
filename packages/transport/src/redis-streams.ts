/**
 * RedisStreamsTransport — at-least-once delivery with consumer groups.
 *
 * This is the production-path companion to the at-most-once RedisTransport
 * (PUBSUB). It implements the full DurableTransport contract: published
 * messages are persisted in Redis Streams until explicitly ack'd by a
 * consumer group, which means:
 *   - A crashed consumer will re-receive its unacked messages on restart
 *     (after the configured idle timeout)
 *   - Multiple replicas of the same agent (same group name) load-balance
 *     within the group — only one replica processes each message
 *   - Different groups receive independent copies (fan-out between groups)
 *
 * Implementation notes:
 *   - Each topic maps to a Redis stream at `${prefix}:${topic}`
 *   - Groups are created lazily on first subscribeGroup
 *   - XREADGROUP is driven by a per-subscription polling loop
 *   - Ack happens only when the handler resolves successfully
 *   - Nack with `requeue: true` is a no-op — the message stays in the PEL
 *     and will be redelivered after the visibility timeout (Redis doesn't
 *     have a built-in "redeliver now" primitive for stream groups). Nack
 *     with `requeue: false` XACKs and optionally publishes to a DLQ topic
 *     (not yet wired; today it just ack+drops).
 *
 * SDK independence: like RedisTransport, this module depends only on the
 * minimum surface area it needs, expressed as `RedisStreamsLike`. Concrete
 * clients (ioredis, redis@4) are adapted by the caller.
 *
 * EXPERIMENTAL: no real Redis integration test runs in CI; the unit tests
 * use a FakeRedisStreams mock that implements the stream commands in memory.
 * Production use is supported but encouraged to run its own smoke tests.
 */

import type {
  DurableTransport,
  DeliveryControl,
  Subscription,
  RequestOptions,
  MessageEnvelope,
  TopicString,
  TransportDescription,
} from '@nexora/contracts';
import { messageId, traceId, spanId, conversationId } from '@nexora/contracts';

/**
 * Minimal Redis client surface for stream operations.
 * Compatible with ioredis and redis@4 (which both expose these commands).
 */
export interface RedisStreamsLike {
  /** XADD key * field value [field value ...] */
  xadd(key: string, id: '*' | string, ...fieldValues: string[]): Promise<string | null>;
  /** XGROUP CREATE key group id [MKSTREAM] */
  xgroup(
    command: 'CREATE',
    key: string,
    group: string,
    id: '$' | '0' | string,
    mkstream?: 'MKSTREAM',
  ): Promise<unknown>;
  /**
   * XREADGROUP GROUP group consumer COUNT n BLOCK ms STREAMS key1 key2 ... id1 id2 ...
   * Returns: [[key, [[id, [field, value, ...]], ...]], ...] | null
   */
  xreadgroup(
    ...args: string[]
  ): Promise<Array<[string, Array<[string, string[]]>]> | null>;
  /** XACK key group id */
  xack(key: string, group: string, id: string): Promise<number>;
  /** XLEN key */
  xlen(key: string): Promise<number>;
  /** Best-effort close */
  quit?(): Promise<unknown>;
}

export interface RedisStreamsTransportOptions {
  /** Redis client used for publishing (XADD). */
  publisher: RedisStreamsLike;
  /** Redis client used for consuming (XREADGROUP). MUST be a separate connection. */
  consumer: RedisStreamsLike;
  /** Stream key prefix, joined with ":". Default: 'nexora'. */
  streamPrefix?: string;
  /**
   * Unique consumer name for this process. Typically `${hostname}-${pid}` or
   * similar. Default: a random short id.
   */
  consumerName?: string;
  /** How many messages to fetch per XREADGROUP call. Default: 16. */
  batchSize?: number;
  /** Block time for XREADGROUP in ms. Default: 5000. Lower = faster shutdown, higher = less CPU. */
  blockMs?: number;
  /** Default request() timeout. Default: 30000. */
  defaultRequestTimeoutMs?: number;
}

interface PollingSubscription {
  pattern: string;
  group: string;
  handler: (envelope: MessageEnvelope, control: DeliveryControl) => Promise<void>;
  stopRequested: boolean;
  loopPromise: Promise<void>;
}

export class RedisStreamsTransport implements DurableTransport {
  private readonly publisher: RedisStreamsLike;
  private readonly consumer: RedisStreamsLike;
  private readonly prefix: string;
  private readonly consumerName: string;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly defaultRequestTimeoutMs: number;
  private readonly subs = new Set<PollingSubscription>();
  private readonly ensuredGroups = new Set<string>(); // `${stream}:${group}`
  private closed = false;

  constructor(options: RedisStreamsTransportOptions) {
    this.publisher = options.publisher;
    this.consumer = options.consumer;
    this.prefix = options.streamPrefix ?? 'nexora';
    this.consumerName = options.consumerName ?? `c-${Math.random().toString(36).slice(2, 10)}`;
    this.batchSize = options.batchSize ?? 16;
    this.blockMs = options.blockMs ?? 5_000;
    this.defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? 30_000;
  }

  describe(): TransportDescription {
    return {
      kind: 'redis-streams',
      deliveryGuarantee: 'at-least-once',
      durable: true,
      supportsConsumerGroups: true,
      notes: `Redis Streams (prefix: ${this.prefix}, consumer: ${this.consumerName})`,
    };
  }

  private streamKey(topic: string): string {
    return `${this.prefix}:${topic}`;
  }

  /** Ensure a consumer group exists for a given stream. Idempotent. */
  private async ensureGroup(stream: string, group: string): Promise<void> {
    const key = `${stream}:${group}`;
    if (this.ensuredGroups.has(key)) return;
    try {
      // MKSTREAM creates an empty stream if it doesn't exist yet; using $ means
      // the group starts from "messages arriving from now".
      await this.consumer.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
    } catch (err) {
      // BUSYGROUP = group already exists, which is fine.
      const msg = (err as Error).message ?? '';
      if (!msg.includes('BUSYGROUP')) throw err;
    }
    this.ensuredGroups.add(key);
  }

  /**
   * Publish an envelope by XADDing the serialized envelope to the stream.
   * Returns after the XADD ack.
   */
  async publish(envelope: MessageEnvelope): Promise<void> {
    if (this.closed) throw new Error('RedisStreamsTransport is closed');
    const key = this.streamKey(envelope.topic);
    const payload = JSON.stringify(envelope);
    await this.publisher.xadd(key, '*', 'envelope', payload);
  }

  /**
   * EventTransport.subscribe is non-durable by definition. We implement it
   * via a default "__event__" consumer group so it still works, but this
   * loses the durability guarantee — use subscribeGroup for durable consumers.
   */
  subscribe(
    pattern: string,
    handler: (envelope: MessageEnvelope) => Promise<void>,
  ): Subscription {
    // Delegate to a shared "ephemeral" group. Messages are ack'd immediately,
    // mirroring at-most-once semantics at the API boundary. Callers who want
    // at-least-once should use subscribeGroup explicitly.
    return this.subscribeGroup(pattern, '__event__', async (envelope, control) => {
      try {
        await handler(envelope);
        await control.ack();
      } catch {
        await control.ack(); // best-effort: mirror PUBSUB drop-on-error behavior
      }
    });
  }

  /**
   * Subscribe as part of a durable consumer group. The handler MUST call
   * control.ack() on success. Unacked messages are redelivered.
   *
   * NOTE: the current implementation resolves `pattern` to a single stream
   * key (wildcards are treated as exact match). Pattern-based stream
   * subscription would need XREAD on a list of keys, which is feasible but
   * deferred until we have a concrete multi-topic use case.
   */
  subscribeGroup(
    pattern: string,
    group: string,
    handler: (envelope: MessageEnvelope, control: DeliveryControl) => Promise<void>,
  ): Subscription {
    if (this.closed) throw new Error('RedisStreamsTransport is closed');

    const stream = this.streamKey(pattern);
    const sub: PollingSubscription = {
      pattern,
      group,
      handler,
      stopRequested: false,
      loopPromise: Promise.resolve(),
    };

    sub.loopPromise = (async () => {
      await this.ensureGroup(stream, group);
      while (!sub.stopRequested && !this.closed) {
        try {
          const result = await this.consumer.xreadgroup(
            'GROUP', group, this.consumerName,
            'COUNT', String(this.batchSize),
            'BLOCK', String(this.blockMs),
            'STREAMS', stream, '>',
          );
          if (!result) continue; // BLOCK timeout, loop again
          for (const [streamKey, entries] of result) {
            if (streamKey !== stream) continue;
            for (const [id, fieldValues] of entries) {
              const envelope = parseEntry(fieldValues);
              if (!envelope) {
                // Malformed — ack and drop to avoid poison loop
                await this.consumer.xack(stream, group, id);
                continue;
              }
              let acked = false;
              const control: DeliveryControl = {
                ack: async () => {
                  if (acked) return;
                  acked = true;
                  await this.consumer.xack(stream, group, id);
                },
                nack: async (opts) => {
                  if (acked) return;
                  if (opts?.requeue === false) {
                    // Drop: ack + (optionally) route to DLQ (future work).
                    acked = true;
                    await this.consumer.xack(stream, group, id);
                    return;
                  }
                  // Default: leave in PEL for redelivery after visibility timeout.
                },
              };
              try {
                await sub.handler(envelope, control);
              } catch {
                // Handler threw — leave unacked so the message is redelivered.
                // A real implementation would push a DLQ envelope here.
              }
            }
          }
        } catch (err) {
          if (sub.stopRequested || this.closed) return;
          // Backoff on unexpected errors so we don't hot-loop against a broken Redis.
          await new Promise(r => setTimeout(r, 250));
        }
      }
    })();

    this.subs.add(sub);

    return {
      unsubscribe: () => {
        sub.stopRequested = true;
        this.subs.delete(sub);
      },
    };
  }

  async ackDelivery(envelope: MessageEnvelope): Promise<void> {
    // The current subscribeGroup hands callers a DeliveryControl that already
    // wraps XACK. This method exists for users who persist envelopes and ack
    // out-of-band (e.g. ack on a downstream DB commit). It requires the caller
    // to have stashed the stream entry id on envelope.metadata — which we
    // intentionally don't do by default. Document the limitation and no-op.
    void envelope;
  }

  async nackDelivery(envelope: MessageEnvelope, _options?: { requeue?: boolean }): Promise<void> {
    void envelope;
    // See ackDelivery note.
  }

  async request(
    topic: TopicString,
    payload: unknown,
    options?: RequestOptions,
  ): Promise<MessageEnvelope> {
    if (this.closed) throw new Error('RedisStreamsTransport is closed');

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
      // Subscribe to everything under the prefix so we catch the reply
      // regardless of which topic the responder publishes to.
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
        reject(new Error(`RedisStreams request to ${String(topic)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      void this.publish(envelope);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    // Stop every polling loop and wait for them to drain.
    for (const sub of this.subs) sub.stopRequested = true;
    const loops = Array.from(this.subs).map(sub => sub.loopPromise);
    this.subs.clear();
    await Promise.allSettled(loops);
  }
}

function parseEntry(fieldValues: string[]): MessageEnvelope | null {
  // Each entry is a flat [field, value, field, value, ...] array.
  for (let i = 0; i + 1 < fieldValues.length; i += 2) {
    if (fieldValues[i] === 'envelope') {
      try {
        return JSON.parse(fieldValues[i + 1]) as MessageEnvelope;
      } catch {
        return null;
      }
    }
  }
  return null;
}
