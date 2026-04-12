/**
 * WorkflowContract — 에이전트 간 협업 흐름 정의.
 *
 * 기존 runner.ts에서 에이전트가 직접 sub-agent를 호출하던 패턴을
 * 선언적 워크플로우로 분리.
 *
 * 에이전트는 워크플로우를 모른다. 오케스트레이터만 이 계약을 읽고 실행한다.
 */

import type { TopicString } from './topic.js';

export interface WorkflowContract {
  /** 워크플로우 고유 이름 */
  name: string;

  /** 설명 */
  description: string;

  /** 이 워크플로우를 트리거하는 조건 */
  trigger: WorkflowTrigger;

  /** 실행 단계 */
  steps: WorkflowStep[];

  /** 워크플로우 레벨 타임아웃 (ms) */
  timeoutMs?: number;

  /**
   * Goal this workflow serves. When set, agents participating in this
   * workflow receive the goal chain in their system prompt via ContextLoader,
   * giving them "why am I doing this?" context for decision-making.
   */
  goalId?: string;
}

export type WorkflowTrigger =
  | { type: 'topic'; topic: TopicString }
  | { type: 'manual'; command: string }
  | { type: 'cron'; expression: string };

export interface WorkflowStep {
  /** 단계 ID (goto에서 참조) */
  id: string;

  /** 이 단계에서 발행할 topic (해당 capability를 가진 에이전트가 처리) */
  topic: TopicString;

  /** 단계에 전달할 입력 (이전 단계 결과를 참조 가능) */
  input?: WorkflowStepInput;

  /** 조건부 분기 */
  onSuccess?: StepTransition;
  onFailure?: StepTransition;

  /** 단계별 타임아웃 (ms) */
  timeoutMs?: number;

  /** 재시도 설정 */
  retry?: RetryPolicy;
}

export type WorkflowStepInput =
  | { type: 'static'; data: unknown }
  | { type: 'fromStep'; stepId: string; path?: string }
  | { type: 'template'; template: string };

export type StepTransition =
  | { action: 'next' }
  | { action: 'goto'; stepId: string }
  | { action: 'end' };

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs?: number;
}
