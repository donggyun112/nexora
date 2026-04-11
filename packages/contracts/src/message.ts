/**
 * MessageEnvelope — 모든 에이전트 간 통신의 기본 단위.
 *
 * 기존 runner.ts의 AgentStreamEvent, ChatMessage, SubAgentEvent를
 * 하나의 범용 메시지 봉투로 통합.
 *
 * 에이전트는 서로를 직접 알지 않고, topic을 통해 메시지를 주고받는다.
 */

export interface MessageEnvelope<T = unknown> {
  /** 메시지 고유 ID */
  id: string;

  /** 발행 topic (에이전트 이름이 아님) */
  topic: string;

  /** 메시지 유형 */
  type: MessageType;

  /** 실제 데이터 */
  payload: T;

  /** 메타데이터 */
  metadata: MessageMetadata;
}

export type MessageType =
  | 'request'      // 작업 요청
  | 'result'       // 작업 결과
  | 'event'        // 브로드캐스트 이벤트
  | 'followup'     // 후속 조치 요청
  | 'progress';    // 진행 상태 업데이트

export interface MessageMetadata {
  /** 최초 요청에서 생성, 전체 흐름 추적 (분산 트레이싱) */
  traceId: string;

  /** 각 에이전트 처리 단위 */
  spanId: string;

  /** 부모 span (호출 체인 추적) */
  parentSpanId?: string;

  /** 하나의 협업 흐름 ID */
  conversationId: string;

  /** 이 메시지가 응답하는 원본 메시지 ID */
  replyTo?: string;

  /** 테넌트 ID */
  tenantId: string;

  /** 발신자 (에이전트 인스턴스 ID, 라우팅 목적이 아닌 추적 목적) */
  sourceInstanceId?: string;

  /**
   * Delegation hop depth — incremented by the `delegate` tool on each hop.
   * Used for cross-process cycle detection: if an envelope arrives with
   * depth >= maxDepth, the receiving agent refuses to process it.
   * Not set on non-delegated messages (treated as 0).
   */
  delegationDepth?: number;

  /**
   * The agent that initiated this delegation (for C2 authorization checks).
   * Set by the delegate tool, propagated on every hop. The receiving bootstrap
   * can check whether the caller is allowed to invoke its capabilities.
   */
  callerAgent?: string;

  /** 생성 시각 (epoch ms) */
  timestamp: number;
}
