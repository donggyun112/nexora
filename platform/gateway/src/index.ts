/**
 * @nexora/gateway — 외부 진입점 ↔ 에이전트 시스템 사이의 라우터.
 *
 * - GatewayRouter: InboundMessage → topic 발행 → 응답
 * - LocalRuntimeRouter: transport 없이 AgentRuntime 직접 호출 (단일 프로세스 + 스트리밍)
 */

export {
  GatewayRouter,
  LocalRuntimeRouter,
} from './router.js';
export type {
  GatewayRouterOptions,
  IntentResolver,
  LocalRuntimeRouterOptions,
} from './router.js';

export { StreamingGatewayRouter } from './streaming-router.js';
export type { StreamingGatewayRouterOptions } from './streaming-router.js';

export {
  createApiKeyAuth,
  createRateLimiter,
  createSecureResolver,
  RateLimitError,
} from './middleware.js';
export type {
  ApiKeyAuthOptions,
  RateLimitOptions,
  RateLimiter,
  SecureResolverOptions,
} from './middleware.js';
