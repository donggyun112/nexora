/**
 * Budget — per-agent and per-tenant cost tracking contracts.
 *
 * Inspired by Paperclip's cost control layer: every LLM call has a token
 * cost, every agent has a budget window, and exceeding the budget pauses
 * the agent rather than silently draining the API key.
 *
 * The budget system has three parts:
 *   1. CostEvent — emitted by LLM providers after every completion
 *   2. BudgetPolicy — declarative limit (per-agent, per-tenant, or global)
 *   3. BudgetTracker — accumulates CostEvents and enforces policies
 */

export interface CostEvent {
  /** Which agent incurred the cost */
  agentName: string;
  /** Tenant the cost belongs to */
  tenantId: string;
  /** LLM model used */
  model: string;
  /** Input tokens consumed */
  inputTokens: number;
  /** Output tokens consumed */
  outputTokens: number;
  /** Estimated USD cost (provider-specific calculation) */
  costUsd: number;
  /** When the call happened */
  timestamp: number;
  /** Trace ID for correlation */
  traceId?: string;
}

export interface BudgetPolicy {
  /** Unique identifier for this policy */
  id: string;
  /** What this policy applies to */
  scope: BudgetScope;
  /** Maximum spend in the window */
  maxCostUsd: number;
  /** Time window */
  window: BudgetWindow;
  /** What happens when the budget is exceeded */
  onExceed: 'pause' | 'warn' | 'block';
}

export type BudgetScope =
  | { type: 'global' }
  | { type: 'tenant'; tenantId: string }
  | { type: 'agent'; agentName: string }
  | { type: 'tenant-agent'; tenantId: string; agentName: string };

export type BudgetWindow =
  | { type: 'hourly' }
  | { type: 'daily' }
  | { type: 'monthly' }
  | { type: 'lifetime' };

export interface BudgetStatus {
  policyId: string;
  scope: BudgetScope;
  windowStart: number;
  windowEnd: number;
  spent: number;
  limit: number;
  remaining: number;
  exceeded: boolean;
}

/**
 * BudgetTracker — accumulates cost events and checks policies.
 *
 * Implementations: InMemoryBudgetTracker (in @nexora/core), persistent
 * variants backed by Store.
 */
export interface BudgetTracker {
  /** Record a cost event. Returns the updated budget status for all matching policies. */
  record(event: CostEvent): Promise<BudgetStatus[]>;

  /** Check current budget status without recording a cost. */
  check(scope: BudgetScope): Promise<BudgetStatus[]>;

  /** Add a budget policy. */
  addPolicy(policy: BudgetPolicy): Promise<void>;

  /** Remove a budget policy. */
  removePolicy(policyId: string): Promise<void>;

  /** List all policies. */
  listPolicies(): Promise<BudgetPolicy[]>;

  /** Get total spend for a scope in the current window. */
  getSpend(scope: BudgetScope, window: BudgetWindow): Promise<number>;
}
