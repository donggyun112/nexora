/**
 * @dongkseo/tenancy — opt-in multi-tenancy for Nexora.
 *
 * The framework core is tenant-unaware. Absent a tenant id, everything runs as
 * a single tenant (`DEFAULT_TENANT`) and no code carries a tenant concept.
 * Import this package only when an app needs to isolate multiple tenants behind
 * one deployment — it bundles the resolver, per-tenant config, and budget
 * scoping needed to make that work.
 *
 * Wiring (HTTP):
 * ```ts
 * import { headerTenantResolver, TenantConfigStore } from '@dongkseo/tenancy';
 * const http = new HttpAdapter({ resolveTenant: headerTenantResolver('x-tenant-id') });
 * const contextLoader = new CoreContextLoader({ tenants: new TenantConfigStore({ root }) });
 * ```
 *
 * See docs/architecture/adrs/adr-001-tenancy-opt-in.md.
 */

// ── 섹션 맵 (어떤 export가 어느 파일에서 오는지) ──────────────────────────────
//   영역          출처                   대표 export
//   Default       @dongkseo/contracts    DEFAULT_TENANT, BudgetScope
//   Tenant config @dongkseo/context      TenantConfigStore, DEFAULT_LIMITS, TenantConfig
//   Resolver      ./resolver             headerTenantResolver, TenantResolver
//   Budget scope  ./budget               tenantBudgetScope, tenantAgentBudgetScope
// ────────────────────────────────────────────────────────────────────────────

export { DEFAULT_TENANT } from '@dongkseo/contracts';
export type { BudgetScope } from '@dongkseo/contracts';

// Per-tenant config (persona / limits / tool allowlist) physically lives in
// @dongkseo/context because the ContextLoader consumes it (moving it here would
// create a cycle). Re-exported so tenancy is the single opt-in entrypoint.
export { TenantConfigStore, DEFAULT_LIMITS } from '@dongkseo/context';
export type { TenantConfig, TenantConfigStoreOptions } from '@dongkseo/context';

export { headerTenantResolver } from './resolver.js';
export type { TenantResolver } from './resolver.js';
export { tenantBudgetScope, tenantAgentBudgetScope } from './budget.js';
