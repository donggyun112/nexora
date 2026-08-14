/**
 * architecture-registry — agent card 의 `architecture` 필드를 실제 factory 호출로
 * 연결하는 단일 dispatch table.
 *
 * agent card 가 `architecture: 'react'` 라고 선언하면 runner 가 이 registry 를
 * 통해 적절한 architecture instance 를 받는다. 미지원 architecture 는 명시적 throw —
 * 카드 오타나 미구현 architecture 선언이 silent 하게 react 로 fall back 되는 일을 막는다.
 *
 * 지금 지원하는 건 react 하나뿐이다. plan-execute 가 있었지만 그건 아키텍처가 아니라
 * 권한 정책이었다 — Claude Code 의 plan mode 는 `toolPermissionContext.mode` 값 하나이고
 * 게이팅은 단일 권한 게이트에서 일어난다. 두 번째 플래너로 만든 게 설계 오류였고,
 * 같은 것이 필요해지면 `RuntimeServices.preToolUse` 스테이지로 돌아온다.
 *
 * Nexora 'Architecture pluggable' 컨셉 적용 (philosophy.md §4).
 */

import { createReactArchitecture } from './react.js';
import type { LoopCompactionOptions } from './loop-helpers.js';
import type { AgentArchitecture } from '@dongkseo/contracts';

export const SUPPORTED_ARCHITECTURES = ['react'] as const;
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
   * 한 턴 내부 history 압축 설정. 카드가 `withinTurnCompaction` 을 선언하면 caller 가
   * 넘긴다(기본 임계값이면 빈 객체). 미지정이면 react 루프 내 프루닝 비활성.
   */
  readonly compaction?: LoopCompactionOptions;
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
