/**
 * InMemoryBudgetTracker — tracks LLM cost per agent/tenant and enforces policies.
 *
 * Records CostEvents from LLM providers, accumulates spend per scope + window,
 * and checks against BudgetPolicy limits. When a policy is exceeded, the
 * tracker returns `exceeded: true` in the BudgetStatus — the caller (bootstrap,
 * AgentRunner, or middleware) decides whether to pause, warn, or block.
 *
 * This is an in-memory implementation. Spend data is lost on restart.
 * For production, back the tracker with a persistent store (Redis sorted sets,
 * Postgres aggregates, etc.) behind the same BudgetTracker interface.
 */

import type {
  BudgetTracker,
  BudgetPolicy,
  BudgetScope,
  BudgetWindow,
  BudgetStatus,
  CostEvent,
  ModelUsage,
} from '@nexora/contracts';

export class InMemoryBudgetTracker implements BudgetTracker {
  private readonly policies: BudgetPolicy[] = [];
  private readonly events: CostEvent[] = [];

  async record(event: CostEvent): Promise<BudgetStatus[]> {
    this.events.push(event);
    // Check all policies that match this event's scope
    const matching = this.policies.filter(p => scopeMatches(p.scope, event));
    return matching.map(p => this.computeStatus(p));
  }

  async check(scope: BudgetScope): Promise<BudgetStatus[]> {
    const matching = this.policies.filter(p => scopeEquals(p.scope, scope));
    return matching.map(p => this.computeStatus(p));
  }

  async addPolicy(policy: BudgetPolicy): Promise<void> {
    const idx = this.policies.findIndex(p => p.id === policy.id);
    if (idx >= 0) this.policies[idx] = policy;
    else this.policies.push(policy);
  }

  async removePolicy(policyId: string): Promise<void> {
    const idx = this.policies.findIndex(p => p.id === policyId);
    if (idx >= 0) this.policies.splice(idx, 1);
  }

  async listPolicies(): Promise<BudgetPolicy[]> {
    return [...this.policies];
  }

  async getSpend(scope: BudgetScope, window: BudgetWindow): Promise<number> {
    const { start, end } = windowRange(window);
    return this.events
      .filter(e => e.timestamp >= start && e.timestamp < end && scopeMatchesEvent(scope, e))
      .reduce((sum, e) => sum + e.costUsd, 0);
  }

  async getModelBreakdown(scope: BudgetScope, window: BudgetWindow): Promise<ModelUsage[]> {
    const { start, end } = windowRange(window);
    const byModel = new Map<string, ModelUsage>();
    for (const e of this.events) {
      if (e.timestamp < start || e.timestamp >= end || !scopeMatchesEvent(scope, e)) continue;
      const existing = byModel.get(e.model);
      if (existing) {
        existing.inputTokens += e.inputTokens;
        existing.outputTokens += e.outputTokens;
        existing.cachedTokens += e.cachedTokens ?? 0;
        existing.costUsd += e.costUsd;
        existing.callCount += 1;
      } else {
        byModel.set(e.model, {
          model: e.model,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          cachedTokens: e.cachedTokens ?? 0,
          costUsd: e.costUsd,
          callCount: 1,
        });
      }
    }
    return [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
  }

  private computeStatus(policy: BudgetPolicy): BudgetStatus {
    const { start, end } = windowRange(policy.window);
    const spent = this.events
      .filter(e => e.timestamp >= start && e.timestamp < end && scopeMatchesEvent(policy.scope, e))
      .reduce((sum, e) => sum + e.costUsd, 0);

    return {
      policyId: policy.id,
      scope: policy.scope,
      windowStart: start,
      windowEnd: end,
      spent,
      limit: policy.maxCostUsd,
      remaining: Math.max(0, policy.maxCostUsd - spent),
      exceeded: spent >= policy.maxCostUsd,
    };
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function windowRange(window: BudgetWindow): { start: number; end: number } {
  const now = new Date();
  switch (window.type) {
    case 'hourly': {
      const start = new Date(now);
      start.setMinutes(0, 0, 0);
      const end = new Date(start);
      end.setHours(end.getHours() + 1);
      return { start: start.getTime(), end: end.getTime() };
    }
    case 'daily': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return { start: start.getTime(), end: end.getTime() };
    }
    case 'monthly': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { start: start.getTime(), end: end.getTime() };
    }
    case 'lifetime':
      return { start: 0, end: Date.now() + 365 * 24 * 3600 * 1000 };
  }
}

function scopeMatchesEvent(scope: BudgetScope, event: CostEvent): boolean {
  switch (scope.type) {
    case 'global': return true;
    case 'tenant': return event.tenantId === scope.tenantId;
    case 'agent': return event.agentName === scope.agentName;
    case 'tenant-agent':
      return event.tenantId === scope.tenantId && event.agentName === scope.agentName;
  }
}

function scopeMatches(scope: BudgetScope, event: CostEvent): boolean {
  return scopeMatchesEvent(scope, event);
}

function scopeEquals(a: BudgetScope, b: BudgetScope): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'global') return true;
  if (a.type === 'tenant' && b.type === 'tenant') return a.tenantId === b.tenantId;
  if (a.type === 'agent' && b.type === 'agent') return a.agentName === b.agentName;
  if (a.type === 'tenant-agent' && b.type === 'tenant-agent') {
    return a.tenantId === b.tenantId && a.agentName === b.agentName;
  }
  return false;
}

/**
 * Estimate USD cost from token counts. Rough pricing — callers should
 * use provider-specific pricing for accuracy. This is a fallback.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Approximate per-million-token pricing (2025 rates)
  const pricing: Record<string, { input: number; output: number }> = {
    'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
    'claude-haiku-4-5': { input: 0.80, output: 4.0 },
    'claude-opus-4': { input: 15.0, output: 75.0 },
    'gpt-4o': { input: 2.5, output: 10.0 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
  };

  const rates = pricing[model] ?? { input: 3.0, output: 15.0 };
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}
