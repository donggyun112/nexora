/**
 * defineAgent() — 에이전트 선언 헬퍼.
 *
 * agents/{name}/agent.config.ts에서 사용.
 * AgentCard를 쉽게 구성하도록 도와주는 빌더.
 */

import type { AgentCard, AgentInlineMode, AgentLimits } from './agent-card.js';
import type { TopicString } from './topic.js';

export interface AgentDefinition {
  /** 에이전트 고유 이름 */
  name: string;

  /** 버전 (기본: '0.1.0') */
  version?: string;

  /** 에이전트 설명 */
  description: string;

  /** 아키텍처 (react, 또는 외부에서 정의한 커스텀 아키텍처) */
  architecture: string;

  /** 사용할 도구 이름 목록 */
  tools: string[];

  /** 이 에이전트가 제공하는 능력 */
  capabilities?: string[];

  /** 구독하는 topic 목록 */
  subscribes?: TopicString[];

  /** 발행하는 topic 목록 */
  publishes?: TopicString[];

  /** 입력 스키마 (JSON Schema) */
  inputSchema?: Record<string, unknown>;

  /** 출력 스키마 (JSON Schema) */
  outputSchema?: Record<string, unknown>;

  /** 시스템 프롬프트 인라인 모드. 없으면 인라인하지 않음. */
  mode?: AgentInlineMode;

  /** mode 로 인라인할 스킬 이름 목록 (확장자 제외) */
  mainSkill?: string[];

  /** ReAct 최대 반복 수 — architecture 기본값 override */
  maxIterations?: number;

  /** 리소스 제한 */
  limits?: AgentLimits;
}

/**
 * 에이전트를 선언적으로 정의.
 * 반환된 AgentCard는 registry에 등록되고 transport가 라우팅에 사용.
 */
export function defineAgent(def: AgentDefinition): AgentCard {
  return {
    name: def.name,
    version: def.version ?? '0.1.0',
    description: def.description,
    capabilities: def.capabilities ?? [],
    subscribes: def.subscribes ?? [],
    publishes: def.publishes ?? [],
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    tools: def.tools,
    architecture: def.architecture,
    mode: def.mode,
    mainSkill: def.mainSkill,
    maxIterations: def.maxIterations,
    limits: def.limits,
  };
}
