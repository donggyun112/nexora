/**
 * Transport — agent-to-agent event communication contract.
 *
 * RPC is forbidden. Agents never name each other. All inter-agent traffic
 * goes through topic-based publish/subscribe, which is what lets the same
 * agent binary serve multiple tenants and scale horizontally.
 *
 * ============================================================================
 * DELIVERY GUARANTEES — read this before choosing a transport:
 *
 * Nexora splits the Transport contract into TWO interfaces so the guarantee
 * is visible in the type system, not buried in implementation docs.
 *
 *   EventTransport (at-most-once, non-durable)
 *     - Fire-and-forget pub/sub
 *     - No acknowledgement, no redelivery on crash
 *     - If a subscriber is absent or slow, the message can be dropped
 *     - Implementations: LocalTransport, RedisTransport (PUBSUB)
 *     - Use for: dev/test, best-effort notifications, broadcast events
 *     - DO NOT USE for: workflow steps, billable work, anything that must
 *       be processed exactly once or whose loss is a bug
 *
 *   DurableTransport extends EventTransport (at-least-once, durable)
 *     - Messages persisted until explicitly ack()'d by a consumer group
 *     - Crashed or slow consumers retry automatically
 *     - Consumer groups give load balancing within a group + fan-out across
 *       groups, so N instances of the same agent don't all process the
 *       same message
 *     - Implementations: RedisStreamsTransport (shipped); KafkaTransport (planned)
 *     - Use for: workflow engine steps, billing events, critical notifications
 *
 * If you pass an EventTransport where a DurableTransport is required, your
 * code will fail to compile. That is the point — the type system now surfaces
 * the operational choice that used to be a footgun.
 *
 * Delivery guarantee matrix:
 *
 *   Transport             | Delivery       | Ordering      | Durability
 *   --------------------- | -------------- | ------------- | ----------
 *   LocalTransport        | at-most-once   | FIFO per sub  | none
 *   RedisTransport        | at-most-once   | per-channel   | none
 *   RedisStreamsTransport | at-least-once  | per-stream    | persisted
 *   KafkaTransport        | at-least-once  | per-partition | persisted
 *
 * The workflow engine (packages/orchestrator/src/engine.ts) currently accepts
 * an EventTransport for dev convenience but emits a runtime warning if it
 * isn't a DurableTransport. In a future major version this will tighten to a
 * compile-time requirement. Production deployments must use a DurableTransport.
 * ============================================================================
 */

import type { MessageEnvelope } from './message.js';
import type { TopicString } from './topic.js';

// ─── Delivery guarantees (type-level markers) ─────────────────────────────

/**
 * Declarative label for the delivery contract a transport provides.
 * Implementations should expose this as a static `deliveryGuarantee` property
 * or via the `describe()` method (preferred — makes runtime assertions easy).
 */
export type DeliveryGuarantee =
  | 'at-most-once'
  | 'at-least-once'
  | 'exactly-once'; // reserved — no implementation today

// ─── EventTransport — at-most-once fire-and-forget ────────────────────────

/**
 * Fire-and-forget pub/sub with NO durability and NO acknowledgement.
 *
 * Implementations MUST:
 *   - Deliver each published message at most once to each matched subscriber
 *   - Drop messages that arrive while no subscriber is listening (no replay)
 *   - Drop messages if the subscriber's handler throws (no retry)
 *   - Fail the publish only on hard transport errors (network down, closed)
 *
 * Implementations MUST NOT claim at-least-once semantics or promise redelivery.
 *
 * Use for: development, testing, best-effort notifications, broadcast-only
 *          events where loss is acceptable.
 */
export interface EventTransport {
  /**
   * Fire-and-forget publish to `envelope.topic`. Returns after the message
   * has been accepted by the transport (not after subscribers have processed it).
   * No redelivery if a subscriber is down or slow.
   */
  publish(envelope: MessageEnvelope): Promise<void>;

  /**
   * Subscribe to topics matching `pattern`. Wildcards: `*` matches a single
   * segment, `#` matches the rest. Returns a Subscription for unsubscribe.
   *
   * The handler runs in whatever consistency context the transport provides.
   * Errors thrown by the handler are NOT retried by EventTransport.
   */
  subscribe(
    pattern: string,
    handler: (envelope: MessageEnvelope) => Promise<void>,
  ): Subscription;

  /**
   * Request/reply pattern built on pub/sub: publish a request envelope,
   * wait for a matching reply envelope (matched via `metadata.replyTo === requestId`),
   * timeout after `options.timeoutMs`. The reply channel inherits the same
   * delivery guarantee as the underlying transport — so on an EventTransport,
   * if the reply is lost, the caller times out.
   */
  request(
    topic: TopicString,
    payload: unknown,
    options?: RequestOptions,
  ): Promise<MessageEnvelope>;

  /**
   * Human-readable description of this transport instance's delivery contract.
   * Used by the workflow engine and observability tools to reason about
   * guarantees without hard-coding class names.
   */
  describe(): TransportDescription;

  /** Close the transport. Subscriptions are invalidated; in-flight operations may reject. */
  close(): Promise<void>;
}

/**
 * Legacy alias. Old code that imported `Transport` continues to work, but
 * it now resolves to `EventTransport` — the weaker of the two guarantees.
 * Code that needs durability must import `DurableTransport` explicitly.
 *
 * @deprecated Import `EventTransport` (or `DurableTransport`) directly.
 */
export type Transport = EventTransport;

// ─── DurableTransport — at-least-once with consumer groups ────────────────

/**
 * Persistent messaging with acknowledgement and consumer groups.
 *
 * Implementations MUST:
 *   - Persist published messages until explicitly ack'd by a consumer group
 *   - Redeliver messages if the handler throws or the process crashes before ack
 *   - Support named consumer groups so horizontally-scaled agents load-balance
 *     within a group and fan-out across groups
 *   - Expose ordering guarantees as part of describe()
 *
 * RedisStreamsTransport (packages/transport) is the reference DurableTransport
 * implementation. The workflow engine still accepts an EventTransport with a
 * runtime warning; a future breaking release will tighten this to a
 * compile-time error.
 */
export interface DurableTransport extends EventTransport {
  /**
   * Subscribe as a member of a consumer group. Messages matching `pattern`
   * are delivered to exactly ONE member of the group (load balancing). Different
   * groups each receive their own independent copy (fan-out between groups).
   *
   * The handler MUST call `ack()` on the envelope (via `ackDelivery`) when
   * successfully processed. If the handler throws OR does not ack within the
   * transport's configured visibility timeout, the message is redelivered.
   */
  subscribeGroup(
    pattern: string,
    group: string,
    handler: (envelope: MessageEnvelope, control: DeliveryControl) => Promise<void>,
  ): Subscription;

  /**
   * Acknowledge a delivered message. After ack, the transport may garbage-collect
   * the message from the durable log.
   */
  ackDelivery(envelope: MessageEnvelope): Promise<void>;

  /**
   * Negatively acknowledge. The transport SHOULD redeliver (possibly with backoff).
   * Optionally routes to a dead-letter topic if configured.
   */
  nackDelivery(envelope: MessageEnvelope, options?: { requeue?: boolean }): Promise<void>;
}

export interface DeliveryControl {
  ack(): Promise<void>;
  nack(options?: { requeue?: boolean }): Promise<void>;
}

// ─── Common types ──────────────────────────────────────────────────────────

export interface TransportDescription {
  /** Implementation identifier, e.g. 'local', 'redis-pubsub', 'redis-streams' */
  kind: string;
  /** Delivery contract this instance provides */
  deliveryGuarantee: DeliveryGuarantee;
  /** Whether messages survive a crash */
  durable: boolean;
  /** Whether consumer groups are supported (only true for DurableTransport) */
  supportsConsumerGroups: boolean;
  /** Free-form notes (e.g. "PUBSUB channel prefix: nexora") */
  notes?: string;
}

export interface Subscription {
  /** Unsubscribe. Safe to call multiple times. */
  unsubscribe(): void;
}

export interface RequestOptions {
  /** Response timeout (ms) */
  timeoutMs?: number;

  /** Distributed tracing / isolation metadata */
  traceId?: string;
  conversationId?: string;
  tenantId?: string;

  /**
   * Delegation metadata — propagated across hops for cycle detection + auth.
   * Set by the delegate tool; read by bootstrap on the receiving end.
   */
  delegationDepth?: number;
  callerAgent?: string;

  /**
   * Tools the child agent must NOT use. Set by the delegate tool;
   * read by bootstrap to filter the child's toolset.
   */
  blockedTools?: string[];

  /**
   * Delegation authority the child inherits (a subset of the delegator's own).
   * Propagated by the delegate tool into `envelope.metadata.inheritedAuthority`.
   */
  inheritedAuthority?: readonly string[];
}

/**
 * Runtime helper: verify a transport is durable before using it for workflow
 * steps or other critical paths. Throws otherwise. Exported so users can call
 * this from their own wiring code; the workflow engine already calls it.
 */
export function assertDurable(transport: EventTransport): asserts transport is DurableTransport {
  const desc = transport.describe();
  if (!desc.durable || desc.deliveryGuarantee === 'at-most-once') {
    throw new Error(
      `Transport "${desc.kind}" provides ${desc.deliveryGuarantee} delivery with ` +
      `durable=${desc.durable}. This operation requires a DurableTransport. ` +
      `Use RedisStreamsTransport or another at-least-once implementation for production.`,
    );
  }
}
