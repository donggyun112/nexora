/**
 * @dongkseo/otel — OpenTelemetry integration for Nexora.
 *
 * Two integration points:
 *   - OTelTransport: wraps EventTransport to emit spans on publish/subscribe/request
 *   - createOTelAgentMiddleware: MiddlewarePipeline plugin for agent execution + tool spans
 *
 * Together they give full-stack traces: HTTP request → gateway → transport →
 * agent bootstrap → architecture loop → tool calls → transport reply, all
 * visible as a single trace in Jaeger/Tempo/Honeycomb.
 *
 * Only depends on @opentelemetry/api (the thin facade). The actual SDK/exporter
 * setup (OTLP, Jaeger, console) is done by the application, not by this package.
 *
 * ── 섹션 맵 ────────────────────────────────────────────────────────────────
 *   transport-middleware.ts  OTelTransport, OTelTransportOptions
 *                            — EventTransport 래퍼. publish/subscribe/request span
 *   agent-middleware.ts      createOTelAgentMiddleware, OTelAgentMiddlewareOptions
 *                            — MiddlewarePipeline 플러그인. 실행 + 도구 호출 span
 * ──────────────────────────────────────────────────────────────────────────
 */

export { OTelTransport } from './transport-middleware.js';
export type { OTelTransportOptions } from './transport-middleware.js';

export { createOTelAgentMiddleware } from './agent-middleware.js';
export type { OTelAgentMiddlewareOptions } from './agent-middleware.js';
