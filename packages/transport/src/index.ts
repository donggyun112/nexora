/**
 * @nexora/transport — agent-to-agent event communication.
 *
 * - LocalTransport: in-memory EventTransport (at-most-once, dev/test)
 * - RedisTransport: Redis PUBSUB EventTransport (at-most-once, distributed)
 * - RedisStreamsTransport: Redis Streams DurableTransport (at-least-once,
 *   consumer groups, durable — production workflow path)
 * - TracingTransport: AsyncLocalStorage-based trace propagation wrapper
 */

export { LocalTransport, createEnvelope } from './local.js';
export type { LocalTransportOptions } from './local.js';

export { RedisTransport } from './redis.js';
export type { RedisTransportOptions, RedisLike } from './redis.js';

export { RedisStreamsTransport } from './redis-streams.js';
export type {
  RedisStreamsTransportOptions,
  RedisStreamsLike,
} from './redis-streams.js';

export { TracingTransport, currentTrace, withTrace } from './tracing.js';
export type { TraceContext } from './tracing.js';
