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
