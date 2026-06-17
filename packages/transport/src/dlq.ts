/**
 * Dead Letter Queue (DLQ) — captures failed messages for inspection/retry.
 *
 * When a subscriber handler throws and the message has exceeded its retry
 * limit (or the transport doesn't support retry), the message is routed to
 * a DLQ topic instead of being silently dropped.
 *
 * DLQ is transport-agnostic: it wraps any EventTransport and intercepts
 * handler errors, publishing the failed envelope to `dlq.{original-topic}`.
 * An operator can subscribe to `dlq.#` to see all failures, or inspect
 * specific topics.
 *
 * Also provides idempotency: each message is checked against a seen-set
 * (keyed by envelope.id). If a message has already been processed, the
 * handler is skipped. This prevents duplicate processing when a durable
 * transport redelivers.
 */

import type {
  EventTransport,
  Subscription,
  RequestOptions,
  MessageEnvelope,
  TopicString,
  TransportDescription,
  AgentLogger,
} from '@dongkseo/contracts';
import { messageId } from '@dongkseo/contracts';

export interface DLQTransportOptions {
  /** The inner transport to wrap. */
  inner: EventTransport;
  /** DLQ topic prefix. Default: 'dlq'. Failed messages go to `{prefix}.{originalTopic}`. */
  dlqPrefix?: string;
  /**
   * Idempotency: how long to remember processed envelope IDs (ms).
   * Default: 3600000 (1 hour). Set to 0 to disable.
   */
  idempotencyWindowMs?: number;
  /** Max seen-set size before oldest entries are evicted. Default: 100000. */
  maxSeenSize?: number;
  /** Logger for DLQ events. */
  logger?: AgentLogger;
}

interface SeenEntry {
  id: string;
  timestamp: number;
}

const NOOP_LOGGER: AgentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

export class DLQTransport implements EventTransport {
  private readonly inner: EventTransport;
  private readonly dlqPrefix: string;
  private readonly idempotencyWindowMs: number;
  private readonly maxSeenSize: number;
  private readonly logger: AgentLogger;
  private readonly seen = new Map<string, number>(); // id → timestamp
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DLQTransportOptions) {
    this.inner = options.inner;
    this.dlqPrefix = options.dlqPrefix ?? 'dlq';
    this.idempotencyWindowMs = options.idempotencyWindowMs ?? 3_600_000;
    this.maxSeenSize = options.maxSeenSize ?? 100_000;
    this.logger = options.logger ?? NOOP_LOGGER;

    // Periodic cleanup of the seen-set
    if (this.idempotencyWindowMs > 0) {
      this.cleanupTimer = setInterval(() => this.cleanupSeen(), 60_000);
      this.cleanupTimer.unref?.();
    }
  }

  describe(): TransportDescription {
    const inner = this.inner.describe();
    return {
      ...inner,
      notes: (inner.notes ? `${inner.notes}; ` : '') +
        `DLQ: ${this.dlqPrefix}.*, idempotency: ${this.idempotencyWindowMs}ms`,
    };
  }

  async publish(envelope: MessageEnvelope): Promise<void> {
    return this.inner.publish(envelope);
  }

  subscribe(
    pattern: string,
    handler: (envelope: MessageEnvelope) => Promise<void>,
  ): Subscription {
    return this.inner.subscribe(pattern, async (envelope) => {
      // Idempotency check
      if (this.idempotencyWindowMs > 0 && this.seen.has(envelope.id)) {
        this.logger.debug(`idempotency skip: ${envelope.id} on ${envelope.topic}`);
        return;
      }

      try {
        await handler(envelope);

        // Mark as processed after successful handling
        if (this.idempotencyWindowMs > 0) {
          this.markSeen(envelope.id);
        }
      } catch (err) {
        // Handler failed — route to DLQ
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`DLQ: ${envelope.topic} → ${this.dlqPrefix}.${envelope.topic}`, {
          envelopeId: envelope.id,
          error: errMsg,
        });

        // Only mark as seen AFTER successful DLQ handoff.
        // If DLQ publish fails, the message stays un-seen so a durable
        // transport can redeliver it on the next attempt. This prevents
        // permanent message loss when both handler AND DLQ are broken.
        let dlqSuccess = false;
        try {
          await this.inner.publish({
            id: messageId(),
            topic: `${this.dlqPrefix}.${envelope.topic}`,
            type: 'event',
            payload: {
              originalEnvelope: envelope,
              error: errMsg,
              failedAt: Date.now(),
            },
            metadata: {
              ...envelope.metadata,
              timestamp: Date.now(),
            },
          });
          dlqSuccess = true;
        } catch (dlqErr) {
          this.logger.error('DLQ publish failed — message will be retried on next delivery', {
            envelopeId: envelope.id,
            dlqError: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
          });
        }

        // Only mark seen after successful DLQ handoff
        if (dlqSuccess && this.idempotencyWindowMs > 0) {
          this.markSeen(envelope.id);
        }
      }
    });
  }

  async request(
    topic: TopicString,
    payload: unknown,
    options?: RequestOptions,
  ): Promise<MessageEnvelope> {
    return this.inner.request(topic, payload, options);
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.seen.clear();
    return this.inner.close();
  }

  /** Number of entries in the idempotency seen-set (for tests). */
  seenSize(): number {
    return this.seen.size;
  }

  private markSeen(id: string): void {
    this.seen.set(id, Date.now());
    // Evict oldest if over capacity
    if (this.seen.size > this.maxSeenSize) {
      const oldest = this.seen.keys().next().value;
      if (oldest) this.seen.delete(oldest);
    }
  }

  private cleanupSeen(): void {
    const cutoff = Date.now() - this.idempotencyWindowMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }
}
