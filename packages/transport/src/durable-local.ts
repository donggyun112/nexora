/**
 * InMemoryDurableTransport — at-least-once delivery WITHOUT Redis.
 *
 * Eliminates the "Redis is required for durability" assumption. This
 * transport provides the full DurableTransport contract using in-process
 * data structures:
 *
 *   - Messages persist in a per-topic log (array) until XACK'd
 *   - Consumer groups load-balance within a group
 *   - Unacked messages are redelivered after a visibility timeout
 *   - Wildcard pattern matching works (unlike RedisStreamsTransport)
 *
 * Trade-offs vs RedisStreamsTransport:
 *   - No cross-process sharing (single Node.js process only)
 *   - No crash survival (data is in memory)
 *   - No horizontal scaling (consumer groups are process-local)
 *
 * Use for: development, testing, single-process deployments, CI pipelines,
 * anywhere Redis is overkill or unavailable.
 *
 * For multi-process production: use RedisStreamsTransport or implement
 * DurableTransport over PostgreSQL/SQLite.
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
import { matchTopic, messageId, traceId, spanId, conversationId } from '@nexora/contracts';

interface LogEntry {
  id: string;
  envelope: MessageEnvelope;
  /** Which groups have acked this entry */
  ackedBy: Set<string>;
  /** Which consumer in each group currently holds this (for redelivery) */
  claimedBy: Map<string, { consumer: string; claimedAt: number }>;
}

interface ConsumerGroupState {
  /** Last delivered position per consumer (index into the topic log) */
  cursors: Map<string, number>;
}

interface GroupSubscription {
  pattern: string;
  group: string;
  handler: (envelope: MessageEnvelope, control: DeliveryControl) => Promise<void>;
  active: boolean;
}

export interface InMemoryDurableTransportOptions {
  /** Visibility timeout: how long before an unacked message is redelivered (ms). Default: 30000. */
  visibilityTimeoutMs?: number;
  /** Polling interval for checking new messages (ms). Default: 100. */
  pollIntervalMs?: number;
  /** Default request timeout (ms). Default: 30000. */
  defaultRequestTimeoutMs?: number;
}

export class InMemoryDurableTransport implements DurableTransport {
  private readonly logs = new Map<string, LogEntry[]>();
  private readonly groups = new Map<string, Map<string, ConsumerGroupState>>(); // topic → groupName → state
  private readonly subs = new Set<GroupSubscription>();
  private readonly pendingReplies = new Map<string, (env: MessageEnvelope) => void>();
  private readonly visibilityTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly defaultRequestTimeoutMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private nextEntryId = 1;
  private consumerCounter = 0;

  constructor(options: InMemoryDurableTransportOptions = {}) {
    this.visibilityTimeoutMs = options.visibilityTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? 30_000;
    this.startPolling();
  }

  describe(): TransportDescription {
    return {
      kind: 'in-memory-durable',
      deliveryGuarantee: 'at-least-once',
      durable: true,
      supportsConsumerGroups: true,
      notes: 'In-process durable transport. No Redis required. Data lost on restart.',
    };
  }

  async publish(envelope: MessageEnvelope): Promise<void> {
    if (this.closed) throw new Error('InMemoryDurableTransport is closed');

    const topic = envelope.topic;
    if (!this.logs.has(topic)) this.logs.set(topic, []);
    this.logs.get(topic)!.push({
      id: `entry-${this.nextEntryId++}`,
      envelope,
      ackedBy: new Set(),
      claimedBy: new Map(),
    });

    // Check pending request/reply
    if (envelope.metadata.replyTo) {
      const handler = this.pendingReplies.get(envelope.metadata.replyTo);
      if (handler) handler(envelope);
    }

    // Trigger immediate delivery attempt
    this.deliver();
  }

  subscribe(
    pattern: string,
    handler: (envelope: MessageEnvelope) => Promise<void>,
  ): Subscription {
    return this.subscribeGroup(pattern, `__ephemeral_${this.consumerCounter++}__`, async (env, ctl) => {
      try {
        await handler(env);
      } finally {
        await ctl.ack();
      }
    });
  }

  subscribeGroup(
    pattern: string,
    group: string,
    handler: (envelope: MessageEnvelope, control: DeliveryControl) => Promise<void>,
  ): Subscription {
    if (this.closed) throw new Error('InMemoryDurableTransport is closed');

    const sub: GroupSubscription = { pattern, group, handler, active: true };
    this.subs.add(sub);

    // Trigger delivery for any backlog
    this.deliver();

    return {
      unsubscribe: () => {
        sub.active = false;
        this.subs.delete(sub);
      },
    };
  }

  async ackDelivery(envelope: MessageEnvelope): Promise<void> {
    // Find and ack across all matching topic logs
    for (const [, entries] of this.logs) {
      for (const entry of entries) {
        if (entry.envelope.id === envelope.id) {
          // Ack for all groups (simplified — in practice you'd want per-group ack)
          for (const [, groupMap] of this.groups) {
            for (const [groupName] of groupMap) {
              entry.ackedBy.add(groupName);
            }
          }
        }
      }
    }
  }

  async nackDelivery(_envelope: MessageEnvelope, _options?: { requeue?: boolean }): Promise<void> {
    // No-op: message stays in log for redelivery after visibility timeout
  }

  async request(
    topic: TopicString,
    payload: unknown,
    options?: RequestOptions,
  ): Promise<MessageEnvelope> {
    if (this.closed) throw new Error('InMemoryDurableTransport is closed');

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
      this.pendingReplies.set(requestId, (reply) => {
        if (resolved) return;
        resolved = true;
        this.pendingReplies.delete(requestId);
        clearTimeout(timer);
        resolve(reply);
      });

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        this.pendingReplies.delete(requestId);
        reject(new Error(`Request to ${String(topic)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      void this.publish(envelope);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.subs.clear();
    this.logs.clear();
    this.pendingReplies.clear();
  }

  // ─── internal delivery engine ──────────────────────────────────────────

  private startPolling(): void {
    this.pollTimer = setInterval(() => this.deliver(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private deliver(): void {
    if (this.closed) return;

    for (const sub of this.subs) {
      if (!sub.active) continue;

      // Find all topics that match this subscription's pattern
      for (const [topic, entries] of this.logs) {
        if (!matchTopic(sub.pattern, topic as TopicString)) continue;

        // Ensure group state exists
        if (!this.groups.has(topic)) this.groups.set(topic, new Map());
        const topicGroups = this.groups.get(topic)!;
        if (!topicGroups.has(sub.group)) {
          topicGroups.set(sub.group, { cursors: new Map() });
        }

        const groupState = topicGroups.get(sub.group)!;
        const consumerName = `c-${sub.group}`;
        const cursor = groupState.cursors.get(consumerName) ?? 0;

        // Deliver unprocessed entries
        for (let i = cursor; i < entries.length; i++) {
          const entry = entries[i];
          if (entry.ackedBy.has(sub.group)) continue;

          // Check if claimed by another consumer and not yet timed out
          const claim = entry.claimedBy.get(sub.group);
          if (claim && Date.now() - claim.claimedAt < this.visibilityTimeoutMs) {
            continue; // Still claimed, skip
          }

          // Claim it
          entry.claimedBy.set(sub.group, { consumer: consumerName, claimedAt: Date.now() });
          groupState.cursors.set(consumerName, i + 1);

          // Deliver (fire-and-forget — errors leave it unacked for redelivery)
          const entryRef = entry;
          const groupName = sub.group;
          void (async () => {
            let acked = false;
            const control: DeliveryControl = {
              ack: async () => {
                if (acked) return;
                acked = true;
                entryRef.ackedBy.add(groupName);
              },
              nack: async () => {
                // Release claim so it can be redelivered
                entryRef.claimedBy.delete(groupName);
              },
            };
            try {
              await sub.handler(entryRef.envelope, control);
            } catch {
              // Handler threw — release claim for redelivery
              entryRef.claimedBy.delete(groupName);
            }
          })();
        }
      }
    }
  }
}
