import type { BudgetScope } from '@dongkseo/contracts';

/** Budget scope covering all spend for a tenant. */
export function tenantBudgetScope(tenantId: string): BudgetScope {
  return { type: 'tenant', tenantId };
}

/** Budget scope covering one agent within a tenant. */
export function tenantAgentBudgetScope(tenantId: string, agentName: string): BudgetScope {
  return { type: 'tenant-agent', tenantId, agentName };
}
