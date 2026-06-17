/**
 * architecture-registry — agent card 의 `architecture` 필드를 실제 factory 호출로
 * 연결하는 단일 dispatch table.
 *
 * agent card 가 `architecture: 'react'` 라고 선언하면 runner 가 이 registry 를
 * 통해 적절한 architecture instance 를 받는다. 미지원 architecture 는 명시적 throw —
 * 카드 오타나 미구현 architecture 선언이 silent 하게 react 로 fall back 되는 일을 막는다.
 *
 * loop architecture 는 `shouldStop` runtime callback 이 필요해 카드 선언만으로
 * 인스턴스화 불가 — 의도적으로 미지원.
 *
 * Nexora 'Architecture pluggable' 컨셉 적용 (philosophy.md §4).
 */

import { createReactArchitecture } from './react.js';
import { createPlanExecuteArchitecture } from './plan-execute.js';
import type { LoopCompactionOptions } from './loop-helpers.js';
import type { AgentArchitecture } from '@dongkseo/contracts';

export const SUPPORTED_ARCHITECTURES = ['react', 'plan-execute'] as const;
export type SupportedArchitecture = (typeof SUPPORTED_ARCHITECTURES)[number];

export interface ArchitectureBuildContext {
  /** 합성된 system prompt — context.systemPrompt + skill bundle. */
  readonly systemPrompt: string;
  /** LLM 모델 id (context.limits.model). */
  readonly model: string;
  /** LLM max output tokens (context.limits.maxTokens). */
  readonly maxTokens: number;
  /** card-news 같이 long-running pipeline 인 경우 iteration 상한 override. */
  readonly maxIterations?: number;
  /**
   * plan-execute 의 EXECUTE phase 에서만 노출할 도구 (PLAN phase 에선 숨김). caller 가
   * card.tools ∩ submit 화이트리스트로 파생해 넘긴다 (에이전트명 하드코딩 없이).
   */
  readonly executePhaseTools?: readonly string[];
  /**
   * 한 턴 내부 history 압축 설정. 카드가 `withinTurnCompaction` 을 선언하면 caller 가
   * 넘긴다(기본 임계값이면 빈 객체). 미지정이면 react 루프 내 프루닝 비활성.
   */
  readonly compaction?: LoopCompactionOptions;
  /** plan-execute 의 PLAN→EXECUTE 전이를 신호하는 도구명. plan-execute 선택 시 필수. */
  readonly exitPlanTool?: string;
}

/**
 * agent card 가 선언한 architecture 문자열을 실제 architecture instance 로 변환.
 *
 * @throws unknown architecture 일 때. fallback 안 함 — 카드 오타는 부팅 시점에 가시화.
 */
export function resolveArchitecture(
  architecture: string,
  buildCtx: ArchitectureBuildContext,
): AgentArchitecture {
  switch (architecture) {
    case 'react':
      return withThinkingLifecycle(
        createReactArchitecture({
          systemPrompt: buildCtx.systemPrompt,
          model: buildCtx.model,
          maxTokens: buildCtx.maxTokens,
          ...(buildCtx.maxIterations !== undefined ? { maxIterations: buildCtx.maxIterations } : {}),
          ...(buildCtx.compaction !== undefined ? { compaction: buildCtx.compaction } : {}),
        }),
      );
    case 'plan-execute':
      if (!buildCtx.exitPlanTool) {
        throw new Error(
          "Architecture 'plan-execute' requires buildCtx.exitPlanTool " +
            '(PLAN→EXECUTE 전이를 신호하는 도구명). 호출자가 명시적으로 주입해야 함.',
        );
      }
      return withThinkingLifecycle(
        createPlanExecuteArchitecture({
          systemPrompt: buildCtx.systemPrompt,
          model: buildCtx.model,
          maxTokens: buildCtx.maxTokens,
          ...(buildCtx.maxIterations !== undefined ? { maxIterations: buildCtx.maxIterations } : {}),
          exitPlanTool: buildCtx.exitPlanTool,
          executePhaseTools: [...(buildCtx.executePhaseTools ?? [])],
        }),
      );
    default:
      throw new Error(
        `Unknown agent architecture: "${architecture}". ` +
          `Supported: ${SUPPORTED_ARCHITECTURES.join(', ')}. ` +
          `agent card 의 'architecture' 필드를 확인하세요.`,
      );
  }
}

export function isSupportedArchitecture(architecture: string): architecture is SupportedArchitecture {
  return (SUPPORTED_ARCHITECTURES as readonly string[]).includes(architecture);
}

function withThinkingLifecycle(inner: AgentArchitecture): AgentArchitecture {
  return {
    ...inner,
    async *loop(runtime, input) {
      yield { type: 'thinking', content: '' };
      yield* inner.loop(runtime, input);
    },
  };
}
