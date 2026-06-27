/**
 * ChannelAdapter — 대화 채널의 능력(capability)을 추상화하는 포트.
 *
 * core(build-runtime)는 채널마다 가능 여부가 다른 동작(스레드형 dispatch,
 * open_thread)을 ID 형태나 어댑터 인스턴스 직접 참조가 아니라 이 포트의
 * 선언으로 게이트한다. 새 채널 추가 = 어댑터 한 개 등록.
 *
 * `threads` 는 "선언 = 능력 + 필요한 콜백 전부" — capability 만 켜고 콜백이
 * 비는 조합(스레드가 무로그로 죽는 silent failure)을 타입으로 차단한다.
 *
 * `typing`·`delivery` 는 채널 중립 UI affordance — 선언한 채널만 그 능력을 가진다.
 * 런타임은 `getChannelAdapter(channel)?.<capability>` 존재로 게이트하고(어댑터 인스턴스
 * 직접 참조 금지), 미선언이면 호출을 건너뛴다(표시 생략 = 데이터 유실 아님).
 * tool-스트리밍·HITL handraise 처럼 페이로드가 앱/렌더러에 종속된 affordance 는
 * 소비 앱이 이 포트를 확장해 선언한다(프레임워크 비-범위).
 */

import type { ToolDefinition } from './tool.js';
import type { AgentRuntime } from './agent.js';

export interface ChannelThreadsCapability {
  /** 채널의 스레드 생성 도구 — orchestrator 의 open_thread 로 노출. */
  openThreadTool: ToolDefinition;
  /** dispatch 가 spawn 한 thread runtime 의 첫 turn 을 채널에서 구동. */
  startFirstTurn(
    threadId: string,
    initialPayload: Record<string, unknown>,
    parentChannelId: string,
  ): void;
  /** shared-thread dispatch — caller 의 채널에 sub-runtime 을 직접 구동. */
  runDelegatedTurn(
    lifecycleThreadId: string,
    threadId: string,
    runtime: AgentRuntime,
    initialPayload: Record<string, unknown>,
    parentChannelId: string,
  ): void;
}

/** delivery capability 가 채널에 게시하는 파일. 프레임워크 중립(Buffer 대신 Uint8Array). */
export interface ChannelAttachment {
  filename: string;
  content: string | Uint8Array;
  /** 첨부와 함께 보낼 본문 텍스트(있으면). */
  body?: string;
}

/** 진행 중(typing) 표시. 채널이 지원하면 선언. */
export interface ChannelTypingCapability {
  /** 해당 채널에서 "작업 중" 신호를 1회 갱신(fire-and-forget). */
  markWorking(channelId: string): void;
}

/** 생성물(마크다운·이미지 등) 채널 게시. 채널이 지원하면 선언. */
export interface ChannelDeliveryCapability {
  postAttachment(channelId: string, attachment: ChannelAttachment): Promise<void>;
}

export interface ChannelAdapter {
  /** envelope.metadata.channel 과 매칭되는 채널 식별자 ('discord' | 'web' | …). */
  channel: string;
  /** 스레드형 dispatch 지원 채널만 선언. 미선언 채널은 delegate(동기)만. */
  threads?: ChannelThreadsCapability;
  /** 진행 중 표시 지원 채널만 선언. 미선언이면 호출자는 표시를 건너뛴다. */
  typing?: ChannelTypingCapability;
  /** 생성물 채널 게시 지원 채널만 선언. 미선언이면 결과는 토픽/스트림으로만 전달. */
  delivery?: ChannelDeliveryCapability;
}
