// ─── Transport: contracts/transport(EventTransport) 구현체 모음 ───────────
//
// 섹션 맵 (에이전트용: 무엇이 어느 파일에 있는지 — 정확한 타입은 해당 파일을 signatures 모드로)
//   Local         ./local         LocalTransport (in-memory, at-most-once), createEnvelope
//   Redis PubSub  ./redis         RedisTransport (PUBSUB, at-most-once, distributed)
//   Redis Streams ./redis-streams RedisStreamsTransport (DurableTransport, at-least-once, consumer group)
//   Durable(mem)  ./durable-local InMemoryDurableTransport (durable 경로 테스트용)
//   DLQ           ./dlq           DLQTransport (중복 제거 + dead-letter 데코레이터)
//   Tracing       ./tracing       TracingTransport, withTrace, currentTrace (AsyncLocalStorage trace 전파)
//
// 인터페이스/타입(EventTransport, DurableTransport, assertDurable)은 @dongkseo/contracts ./transport.

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

export { DLQTransport } from './dlq.js';
export type { DLQTransportOptions } from './dlq.js';

export { InMemoryDurableTransport } from './durable-local.js';
export type { InMemoryDurableTransportOptions } from './durable-local.js';
