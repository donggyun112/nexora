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
 * 결과 게시·typing indicator 등 UI affordance 는 토픽 pub/sub 와
 * getDiscordAdapter 경유로 남아 있음 — 일반화는 별도 결정
 * (wiki/decisions/2026-06-09-multichannel-persistence-architecture.md P2 비-범위).
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

export interface ChannelAdapter {
  /** envelope.metadata.channel 과 매칭되는 채널 식별자 ('discord' | 'web' | …). */
  channel: string;
  /** 스레드형 dispatch 지원 채널만 선언. 미선언 채널은 delegate(동기)만. */
  threads?: ChannelThreadsCapability;
}
