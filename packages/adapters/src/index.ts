/**
 * @nexora/adapters — 외부 진입점 어댑터.
 *
 * - HttpAdapter: REST API (node:http 기반, express 비의존)
 *
 * Discord/Slack 등 추가 어댑터는 사용자가 Adapter 인터페이스 구현.
 */

export { HttpAdapter } from './http.js';
export type { HttpAdapterOptions } from './http.js';
