/**
 * @nexora/transport — 에이전트 간 이벤트 통신.
 *
 * - LocalTransport: 인메모리 (개발/테스트)
 * - RedisTransport: 분산 (프로덕션, ioredis/redis 어댑터)
 * - TracingTransport: AsyncLocalStorage 기반 trace 자동 전파
 */

export { LocalTransport, createEnvelope } from './local.js';
export type { LocalTransportOptions } from './local.js';

export { RedisTransport } from './redis.js';
export type { RedisTransportOptions, RedisLike } from './redis.js';

export { TracingTransport, currentTrace, withTrace } from './tracing.js';
export type { TraceContext } from './tracing.js';
