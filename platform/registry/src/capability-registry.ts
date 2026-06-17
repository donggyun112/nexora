/**
 * CapabilityRegistry — L0. Strategy 패턴 기반 capability → agent 라우팅.
 *
 * 도메인 매니저 / service-type 에이전트 / 외부 서비스 strategy 모두 같은 registry 에
 * 등록되며, dispatch 도구는 이 registry 를 통해 capability id + (optional)
 * strategy id + (optional) hints 로 실제 agent 를 찾는다.
 *
 * 네임스페이스 컨벤션:
 *   - domain.<domain>           — L1 도메인 매니저 (예: domain.marketing)
 *   - <domain>.<service-type>   — L2 service-type 에이전트 (예: marketing.seo-keyword)
 *   - capability.<name>         — L3 도메인 무관 능력 (예: capability.channel-publish)
 *
 * SoT: docs/superpowers/specs/2026-05-26-capability-registry-strategy-extension.md
 */

export type CapabilityId = string;
export type StrategyId = string;

export interface StrategyEntry {
  readonly strategyId: StrategyId;
  readonly agentName: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly metadata?: Record<string, unknown>;
}

/**
 * HintRouter 반환:
 *   - StrategyId       — 같은 capability 안에서 strategy 선택
 *   - { redirectTo }   — 다른 capability 로 리다이렉트 (legacy reroute 일반화)
 *   - undefined        — 다음 router 시도
 */
export type HintRouterResult = StrategyId | { redirectTo: CapabilityId } | undefined;
export type HintRouter = (hints: Record<string, unknown>) => HintRouterResult;
import type { InputContract } from './capability-input-contract.js';

export interface CapabilityEntry {
  readonly capability: CapabilityId;
  readonly description: string;
  readonly strategies: ReadonlyMap<StrategyId, StrategyEntry>;
  readonly defaultStrategy?: StrategyId;
  /** hints 로부터 strategyId 를 추론. 명시적 strategyId 미지정 시 순서대로 시도. */
  readonly hintRouters?: ReadonlyArray<HintRouter>;
  readonly metadata?: Record<string, unknown>;
  readonly inputContract?: InputContract;
}

export type ResolveInput = {
  capability: CapabilityId;
  strategyId?: StrategyId;
  hints?: Record<string, unknown>;
};

export type ResolveResult =
  | { ok: true; capability: CapabilityId; strategy: StrategyEntry }
  | { ok: false; error: string };

export interface CapabilityRegistry {
  registerCapability(entry: CapabilityEntry): void;
  getCapability(capability: CapabilityId): CapabilityEntry | undefined;
  listCapabilities(): readonly CapabilityEntry[];
  resolve(input: ResolveInput): ResolveResult;
}

export function createCapabilityRegistry(): CapabilityRegistry {
  const entries = new Map<CapabilityId, CapabilityEntry>();

  /** hintRouter 결과 — strategyId, redirect, undefined 셋 중 하나. */
  function runHintRouters(
    entry: CapabilityEntry,
    hints: Record<string, unknown> | undefined,
  ): HintRouterResult {
    if (!hints || !entry.hintRouters) return undefined;
    for (const router of entry.hintRouters) {
      const r = router(hints);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  function resolveInner(
    input: ResolveInput,
    visited: readonly CapabilityId[],
  ): ResolveResult {
    if (visited.includes(input.capability)) {
      return {
        ok: false,
        error: `redirect cycle: ${[...visited, input.capability].join(' → ')}`,
      };
    }
    const entry = entries.get(input.capability);
    if (!entry) {
      return { ok: false, error: `unknown capability: ${input.capability}` };
    }

    // hint routers 는 strategyId 유무와 무관하게 항상 먼저 평가. redirect 가
    // 발생하면 capability 자체가 바뀌므로, 호출자가 박은 explicit strategyId
    // (원래 capability 의 strategy) 는 의미를 잃고 폐기된다.
    const hint = runHintRouters(entry, input.hints);
    if (hint && typeof hint === 'object' && 'redirectTo' in hint) {
      return resolveInner(
        { capability: hint.redirectTo, hints: input.hints },
        [...visited, input.capability],
      );
    }

    // 같은 capability 안에서 strategy 선택:
    //   explicit strategyId > hint router strategyId > defaultStrategy.
    let stratId: StrategyId | undefined = input.strategyId;
    if (!stratId) {
      stratId = typeof hint === 'string' ? hint : entry.defaultStrategy;
    }

    if (!stratId) {
      return {
        ok: false,
        error: `${input.capability}: strategyId required (no default, hints did not match)`,
      };
    }
    const strat = entry.strategies.get(stratId);
    if (!strat) {
      return { ok: false, error: `unknown strategy "${stratId}" for ${input.capability}` };
    }
    if (!strat.enabled) {
      return { ok: false, error: `strategy disabled: ${input.capability}/${stratId}` };
    }
    return { ok: true, capability: input.capability, strategy: strat };
  }

  return {
    registerCapability(entry) {
      entries.set(entry.capability, entry);
    },

    getCapability(capability) {
      return entries.get(capability);
    },

    listCapabilities() {
      return Array.from(entries.values());
    },

    resolve(input) {
      return resolveInner(input, []);
    },
  };
}
