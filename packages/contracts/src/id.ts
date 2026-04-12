/**
 * ID 생성 헬퍼.
 *
 * 모든 패키지에서 사용하는 고유 ID 생성.
 * crypto.randomUUID() 기반 — prefix로 용도 구분.
 */

import { randomUUID } from 'node:crypto';

/** prefix 붙은 UUID 생성 */
export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

/** 메시지 ID */
export function messageId(): string {
  return createId('msg');
}

/** trace ID (분산 추적) */
export function traceId(): string {
  return createId('trace');
}

/** span ID (에이전트 실행 단위) */
export function spanId(): string {
  return createId('span');
}

/** conversation ID */
export function conversationId(): string {
  return createId('conv');
}

/** audit entry ID */
export function auditId(): string {
  return createId('audit');
}

/** job ID (스케줄러) */
export function jobId(): string {
  return createId('job');
}

// ─── W3C TraceContext compatible IDs ───────────────────────────────────────
// OTel requires 32-hex traceId and 16-hex spanId (no prefix, no dashes).
// These are used by @nexora/otel to bridge Nexora traces into W3C format.

import { randomBytes } from 'node:crypto';

/** 32-char hex trace ID (W3C TraceContext compatible) */
export function w3cTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** 16-char hex span ID (W3C TraceContext compatible) */
export function w3cSpanId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Extract a W3C-compatible 32-hex traceId from a Nexora ID.
 * If the ID is already 32 hex chars, returns as-is.
 * If it has a prefix (e.g. 'trace_abc123...'), strips the prefix.
 * If it's too short, pads with zeros. Too long, truncates.
 */
export function toW3CTraceId(nexoraId: string): string {
  const hex = nexoraId.replace(/^[a-z]+_/, '').replace(/-/g, '');
  if (hex.length === 32) return hex;
  if (hex.length > 32) return hex.slice(0, 32);
  return hex.padEnd(32, '0');
}

/**
 * Extract a W3C-compatible 16-hex spanId from a Nexora ID.
 */
export function toW3CSpanId(nexoraId: string): string {
  const hex = nexoraId.replace(/^[a-z]+_/, '').replace(/-/g, '');
  if (hex.length === 16) return hex;
  if (hex.length > 16) return hex.slice(0, 16);
  return hex.padEnd(16, '0');
}
