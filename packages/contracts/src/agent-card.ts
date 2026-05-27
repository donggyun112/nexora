/**
 * AgentCard — 에이전트의 능력 선언.
 *
 * A2A의 Agent Card 개념을 차용.
 * registry에 등록되어 transport가 topic 라우팅에 활용.
 *
 * 기존 runner.ts의 ToolSetOptions, SubAgentToolset 개념을 일반화.
 */

import type { TopicString } from './topic.js';

export interface AgentCard {
  /** 에이전트 고유 이름 */
  name: string;

  /** 버전 (semver) */
  version: string;

  /** 에이전트 설명 */
  description: string;

  /** 이 에이전트가 제공하는 능력 */
  capabilities: string[];

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
