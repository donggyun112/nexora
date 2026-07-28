/**
 * Delegation **authority attenuation** — the no-escalation invariant for agent
 * delegation. Authority is a set of policy groups (the same `<domain>.<action>`
 * vocabulary tools declare via `permissionGroups`). When agent A delegates to
 * agent B, B's authority can only ever be a **subset** of A's — never a superset.
 * Composed transitively, a whole delegation chain can only narrow, never widen.
 *
 * This is the piece that makes delegation safe: without it, a child could be
 * handed — or could declare — a group its parent never held. Two primitives:
 *   - {@link attenuate} computes a child's inherited authority from the parent's.
 *   - {@link createEscalationGuard} turns an inherited set into an approval-gate
 *     resolver that `deny`s any group outside it (riding the gate's existing
 *     deny short-circuit — no separate enforcement path).
 *
 * `undefined` authority means "root / unrestricted": the top of a delegation
 * chain imposes no ceiling until it chooses to scope down.
 */

import type { ApprovalGatePolicyResolver } from './approval-middleware.js';

/**
 * Compute a child's inherited authority.
 *
 * - `parent === undefined` (root): the child gets exactly what it `requested`
 *   (or stays unrestricted when it requests nothing).
 * - `requested === undefined`: the child inherits the parent's full set.
 * - otherwise: the **intersection** — the child keeps only groups the parent
 *   also holds. The result is therefore always ⊆ parent (no escalation).
 */
export function attenuate(
  parent: readonly string[] | undefined,
  requested: readonly string[] | undefined,
): string[] | undefined {
  if (parent === undefined) return requested ? [...requested] : undefined;
  if (requested === undefined) return [...parent];
  const allowed = new Set(parent);
  return requested.filter((group) => allowed.has(group));
}

/**
 * Build an approval-gate resolver that enforces an inherited authority set:
 * any policy group outside the set resolves to `deny`; groups inside resolve to
 * `skip` (this guard imposes no opinion beyond the ceiling). `undefined` =
 * unrestricted → never denies.
 */
export function createEscalationGuard(
  inherited: readonly string[] | undefined,
): ApprovalGatePolicyResolver {
  if (inherited === undefined) return () => 'skip';
  const allowed = new Set(inherited);
  return (ctx) => (allowed.has(ctx.policyGroup) ? 'skip' : 'deny');
}
