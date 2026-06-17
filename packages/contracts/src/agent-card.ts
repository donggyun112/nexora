/**
 * AgentCard — 에이전트의 능력 선언.
 *
 * A2A의 Agent Card 개념을 차용.
 * registry에 등록되어 transport가 topic 라우팅에 활용.
 *
 * 기존 runner.ts의 ToolSetOptions, SubAgentToolset 개념을 일반화.
 */

import type { CapabilityRef } from './capability.js';
import type { RuntimeSpec } from './runtime.js';
import type { TopicString } from './topic.js';

/** 시스템 프롬프트 인라인 모드 — 'workflow'(강제 절차) | 'principles'(판단 기준). */
export type AgentInlineMode = 'workflow' | 'principles';

export interface AgentCard {
  /** 에이전트 고유 이름 */
  name: string;

  /** 버전 (semver) */
  version: string;

  /** 에이전트 설명 */
  description: string;

  /** 이 에이전트가 제공하는 능력 */
  capabilities: CapabilityRef[];

  provides?: CapabilityRef[];

  /** 구독하는 topic 목록 (이 topic에 대한 메시지를 수신) */
  subscribes: TopicString[];

  /** 발행하는 topic 목록 (이 topic으로 메시지를 발행) */
  publishes: TopicString[];

  /** 입력 스키마 (JSON Schema) */
  inputSchema?: Record<string, unknown>;

  /** 출력 스키마 (JSON Schema) */
  outputSchema?: Record<string, unknown>;

  /** 사용하는 도구 이름 목록 */
  tools: string[];

  /** 에이전트 아키텍처 (react, 또는 외부에서 정의한 커스텀 아키텍처) */
  architecture: string;

  runtime?: RuntimeSpec;

  /** 시스템 프롬프트 인라인 모드. 없으면 인라인하지 않음 (스킬 메뉴만 노출). */
  mode?: AgentInlineMode;

  /** mode 로 인라인할 스킬 이름 목록 (skills 디렉터리의 .md, 확장자 제외) */
  mainSkill?: string[];

  /** ReAct 최대 반복 수 — architecture 기본값 override */
  maxIterations?: number;

  /** 같은 conversationId 의 turn 을 single-writer 로 직렬화 (여러 드라이버가 한 대화를 구동하는 에이전트용). */
  serializeTurnsByConversation?: boolean;

  /** 한 턴 내부에서 누적되는 로컬 history 를 결정적으로 프루닝 (react 아키텍처 전용 opt-in). */
  withinTurnCompaction?: boolean;

  /** 리소스 제한 */
  limits?: AgentLimits;
}

export interface AgentLimits {
  /** 최대 실행 시간 (ms) — 기존 DEFAULT_TIMEOUT_MS에서 가져옴 */
  maxExecutionMs?: number;

  /** 최대 토큰 사용량 */
  maxTokens?: number;

  /** 동시 실행 수 */
  maxConcurrency?: number;
}
