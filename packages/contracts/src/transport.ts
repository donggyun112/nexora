/**
 * Transport — 에이전트 간 이벤트 통신 계약.
 *
 * RPC가 아닌 이벤트 중심. 에이전트 이름 직접 호출 금지.
 * topic/capability 기반 publish/subscribe만 허용.
 */

import type { MessageEnvelope } from './message.js';
import type { TopicString } from './topic.js';

export interface Transport {
  /** topic에 메시지 발행 */
  publish(envelope: MessageEnvelope): Promise<void>;

  /** topic 구독 (패턴 매칭 지원) */
  subscribe(
    pattern: string,
    handler: (envelope: MessageEnvelope) => Promise<void>,
  ): Subscription;

  /** request-reply 패턴 (단일 응답 대기) */
  request(
    topic: TopicString,
    payload: unknown,
    options?: RequestOptions,
  ): Promise<MessageEnvelope>;

  /** 연결 종료 */
  close(): Promise<void>;
}

export interface Subscription {
  /** 구독 해제 */
  unsubscribe(): void;
}

export interface RequestOptions {
  /** 응답 대기 타임아웃 (ms) */
  timeoutMs?: number;

  /** 메시지 메타데이터 */
  traceId?: string;
  conversationId?: string;
  tenantId?: string;
}
