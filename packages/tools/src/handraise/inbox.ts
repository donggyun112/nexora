/**
 * HandraiseInbox — in-process queue of pending handraises.
 *
 * Subscribes to `handraise.human.*` topics and holds incoming requests in
 * memory until a UI (or test) calls `answer()`. When answered, publishes
 * a reply envelope with `metadata.replyTo` set to the original request id,
 * which unblocks the agent's `transport.request()` call.
 *
 * This is the minimum viable "human side" of handraise. Real deployments
 * should expose an HTTP / WebSocket / Slack UI on top of this inbox that
 * a human operator interacts with. For tests and small demos, callers can
 * drive the inbox directly.
 */

import type {
  EventTransport,
  MessageEnvelope,
  Subscription,
  TopicString,
} from '@nexora/contracts';
import { messageId, spanId } from '@nexora/contracts';

export interface PendingHandraise {
  /** Internal id for answering (distinct from envelope.id). */
  id: string;
  /** The original request envelope, so callers see full context. */
  envelope: MessageEnvelope;
  /** Channel this request landed on (extracted from the topic suffix). */
  channel: string;
  /** When the request arrived. */
  receivedAt: number;
}

export interface HandraiseInboxOptions {
  transport: EventTransport;
  /**
   * Channels to subscribe to. Each becomes a subscription to
   * `handraise.human.<channel>`. Default: `['default']`.
   */
  channels?: string[];
}

export class HandraiseInbox {
  private readonly transport: EventTransport;
  private readonly channels: string[];
  private readonly pending = new Map<string, PendingHandraise>();
  private readonly subscriptions: Subscription[] = [];
  private nextId = 1;
  private started = false;

  constructor(options: HandraiseInboxOptions) {
    this.transport = options.transport;
    this.channels = options.channels ?? ['default'];
  }

  /** Begin subscribing to the configured channels. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const channel of this.channels) {
      const topic = `handraise.human.${channel}`;
      const sub = this.transport.subscribe(topic, async (envelope) => {
        const id = `hr-${this.nextId++}`;
        this.pending.set(id, {
          id,
          envelope,
          channel,
          receivedAt: Date.now(),
        });
      });
      this.subscriptions.push(sub);
    }
  }

  /** Stop subscribing and clear pending state. */
  stop(): void {
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions.length = 0;
    this.pending.clear();
    this.started = false;
  }

  /** Snapshot of currently-pending handraises. */
  list(): PendingHandraise[] {
    return Array.from(this.pending.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  /** Count of pending handraises. */
  size(): number {
    return this.pending.size;
  }

  /**
   * Answer a pending handraise. Removes it from the queue and publishes a
   * reply envelope with `metadata.replyTo` set so the originating
   * `transport.request()` call resolves.
   */
  async answer(
    id: string,
    answer: unknown,
    options: { rationale?: string } = {},
  ): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) throw new Error(`No pending handraise with id "${id}"`);
    this.pending.delete(id);

    const reply: MessageEnvelope = {
      id: messageId(),
      topic: `${entry.envelope.topic}.answered`,
      type: 'result',
      payload: {
        answer,
        rationale: options.rationale,
      },
      metadata: {
        traceId: entry.envelope.metadata.traceId,
        spanId: spanId(),
        parentSpanId: entry.envelope.metadata.spanId,
        conversationId: entry.envelope.metadata.conversationId,
        replyTo: entry.envelope.id,
        tenantId: entry.envelope.metadata.tenantId,
        sourceInstanceId: 'handraise-inbox',
        timestamp: Date.now(),
      },
    };

    await this.transport.publish(reply);
  }

  /** Reject a pending handraise without an answer (lets the agent know it was denied). */
  async reject(id: string, reason: string): Promise<void> {
    await this.answer(id, { rejected: true, reason }, { rationale: reason });
  }
}
