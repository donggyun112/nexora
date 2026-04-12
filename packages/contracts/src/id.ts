/**
 * ID 생성 헬퍼.
 *
 * 모든 패키지에서 사용하는 고유 ID 생성.
 * crypto.randomUUID() 기반 — prefix로 용도 구분.
 */

import { randomUUID, createHash } from 'node:crypto';

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
 * Strips prefix, normalizes hex. If the result is not exactly 32 hex chars,
 * hashes the input to produce a deterministic 32-hex ID instead of
 * padding/truncating (which was collision-prone for arbitrary inputs).
 *
 * R6 FIX: reject all-zero results (invalid in W3C TraceContext).
 */
export function toW3CTraceId(nexoraId: string): string {
  const hex = nexoraId.replace(/^[a-z]+_/, '').replace(/-/g, '');
  if (/^[0-9a-f]{32}$/.test(hex) && hex !== '0'.repeat(32)) return hex;
  // Hash to 32 hex — deterministic, collision-resistant
  const hash = createHash('md5').update(nexoraId).digest('hex');
  return hash === '0'.repeat(32) ? '0'.repeat(31) + '1' : hash;
}

/**
 * Extract a W3C-compatible 16-hex spanId from a Nexora ID.
 * Same approach: exact match or hash. 128-bit Nexora IDs are necessarily
 * lossy when mapped to 64-bit W3C span IDs, but the hash is deterministic.
 */
export function toW3CSpanId(nexoraId: string): string {
  const hex = nexoraId.replace(/^[a-z]+_/, '').replace(/-/g, '');
  if (/^[0-9a-f]{16}$/.test(hex) && hex !== '0'.repeat(16)) return hex;
  const hash = createHash('md5').update(nexoraId).digest('hex').slice(0, 16);
  return hash === '0'.repeat(16) ? '0'.repeat(15) + '1' : hash;
}
