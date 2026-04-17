/**
 * Adapter — 진입점 계약.
 *
 * 기존 Discord integration을 어댑터 패턴으로 추상화.
 * Discord, Slack, HTTP API 등 어떤 진입점이든 이 인터페이스를 구현.
 */

export interface Adapter {
  /** 어댑터 이름 */
  name: string;

  /** 시작 (메시지 라우터에 연결) */
  start(router: MessageRouter): Promise<void>;

  /** 종료 */
  stop(): Promise<void>;
}

export interface MessageRouter {
  /** 외부에서 들어온 메시지를 시스템으로 라우팅 */
  route(message: InboundMessage): Promise<OutboundMessage>;

  /** 스트리밍 응답 */
  routeStream(
    message: InboundMessage,
    onChunk: (chunk: OutboundChunk) => void,
  ): Promise<void>;
}

export interface InboundMessage {
  /** 원본 플랫폼 (discord, slack, http 등) */
  platform: string;

  /** 플랫폼별 채널/스레드 ID */
  channelId: string;

  /** 플랫폼별 사용자 ID */
  userId: string;

  /** 사용자 표시 이름 */
  displayName: string;

  /** 메시지 본문 */
  content: string;

  /** 첨부 이미지 */
  images?: { data: string; mimeType: string }[];

  /** 테넌트 ID (Gateway가 해석해서 주입) */
  tenantId: string;

  /** 대화 ID (스레드 기반 연속 대화 추적) */
  conversationId?: string;

  /** Platform-specific metadata (e.g., mentionedAgent for Discord @mention routing) */
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  content: string;
  metadata?: Record<string, unknown>;
}

export type OutboundChunk =
  | { type: 'text'; text: string; agent?: string }
  | { type: 'tool_call'; name: string; input?: unknown; agent?: string }
  | { type: 'tool_result'; name: string; isError: boolean; agent?: string }
  | { type: 'thinking'; content: string; agent?: string }
  | { type: 'done'; content: string; agent?: string }
  | { type: 'delegate_start'; from: string; to: string; capability: string }
  | { type: 'delegate_end'; from: string; to: string }
  | { type: 'error'; message: string; agent?: string }
  | { type: 'error'; message: string };
