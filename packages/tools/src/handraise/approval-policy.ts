/**
 * Group-based approval **decider** — the framework-canonical policy engine that
 * turns a `<domain>.<action>` policy group into a `skip | ask | block | deny`
 * decision, and layers multiple rule sources by precedence.
 *
 * This is the pure composition rule, lifted out of the product runtime so every
 * consumer shares one definition of "how policy groups combine". It owns NO
 * config format: tools *declare* their groups (`ToolDefinition.policyGroups` /
 * `permissionGroups`), and a source (YAML, env, code) supplies {@link PolicyRules}.
 * Parsing/loading that source (fs, yaml, zod) is deliberately left to the caller
 * so this module stays dependency-free and usable in any runtime.
 *
 * Composition semantics (the invariant every consumer must agree on):
 *   - A group `d.a` is matched on two axes: `byDomain[d]` and `byAction[a]`.
 *   - When both axes match, the **more restrictive** action wins:
 *     `deny > block > ask > skip`.
 *   - No match → `skip` (declared groups are controlled; the rest pass —
 *     permissive default for autonomous agents).
 *   - Layered sources merge front→back; a later source overrides an earlier one
 *     per rule key (mirrors Claude Code's policy > project > user precedence).
 *
 * Plug into the gate via {@link createGroupPolicyResolver}, which adapts a
 * {@link PolicyRules} set to the middleware's `resolveGroupAction` seam.
 */

import type {
  ApprovalGatePolicyAction,
  ApprovalGatePolicyResolver,
  ApprovalMode,
} from './approval-middleware.js';

/**
 * Rule set for the decider. Actions are the gate's own vocabulary
 * (`skip | ask | block | deny`) — any config-level aliasing (e.g. YAML `allow`
 * → `skip`) is the loader's job, not this module's.
 */
export interface PolicyRules {
  /** Global gate mode hint (off/ask/block). Consumed by the middleware, not by `decide`. */
  mode?: ApprovalMode;
  /** `<domain>` → action. */
  byDomain: Record<string, ApprovalGatePolicyAction>;
  /** `<action>` → action (the segment after the last dot; whole string if dotless). */
  byAction: Record<string, ApprovalGatePolicyAction>;
}

/** More restrictive wins. Flip an entry here only if you want a laxer axis to override. */
const SEVERITY: Record<ApprovalGatePolicyAction, number> = {
  skip: 0,
  ask: 1,
  block: 2,
  deny: 3,
};

/**
 * Resolve one policy group to its action. Matches the domain and action axes,
 * returns the more restrictive of any matches, or `skip` when nothing matches.
 */
export function decide(rules: PolicyRules, policyGroup: string): ApprovalGatePolicyAction {
  const dot = policyGroup.lastIndexOf('.');
  const domain = dot >= 0 ? policyGroup.slice(0, dot) : '';
  const action = dot >= 0 ? policyGroup.slice(dot + 1) : policyGroup;

  const matched = [rules.byDomain[domain], rules.byAction[action]].filter(
    (a): a is ApprovalGatePolicyAction => a != null,
  );

  return matched.reduce<ApprovalGatePolicyAction>(
    (acc, a) => (SEVERITY[a] > SEVERITY[acc] ? a : acc),
    'skip',
  );
}

/**
 * Merge two rule sources. `over` wins per key (layered override); `mode` prefers
 * the explicitly-set side (`over ?? base`). Use `reduce` over an ordered list to
 * layer more than two sources.
 */
export function mergeRules(base: PolicyRules, over: PolicyRules): PolicyRules {
  return {
    mode: over.mode ?? base.mode,
    byDomain: { ...base.byDomain, ...over.byDomain },
    byAction: { ...base.byAction, ...over.byAction },
  };
}

/**
 * Adapt a {@link PolicyRules} set to the approval-gate `resolveGroupAction` seam.
 * The gate calls this once per declared policy group and applies its own
 * precedence (deny/block short-circuit, first ask wins).
 */
export function createGroupPolicyResolver(rules: PolicyRules): ApprovalGatePolicyResolver {
  return (ctx) => decide(rules, ctx.policyGroup);
}
