import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { DEFAULT_TENANT } from '@dongkseo/contracts';
import { headerTenantResolver, tenantBudgetScope, tenantAgentBudgetScope } from '../index.js';

function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('headerTenantResolver', () => {
  it('reads the tenant from the default x-tenant-id header', () => {
    expect(headerTenantResolver()(req({ 'x-tenant-id': 'acme' }))).toBe('acme');
  });

  it('supports a custom header name', () => {
    expect(headerTenantResolver('x-org')(req({ 'x-org': 'startup' }))).toBe('startup');
  });

  it('falls back to DEFAULT_TENANT when the header is absent', () => {
    expect(headerTenantResolver()(req({}))).toBe(DEFAULT_TENANT);
  });

  it('falls back when the header is blank', () => {
    expect(headerTenantResolver()(req({ 'x-tenant-id': '   ' }))).toBe(DEFAULT_TENANT);
  });

  it('takes the first value for array-valued headers', () => {
    expect(headerTenantResolver()(req({ 'x-tenant-id': ['t1', 't2'] }))).toBe('t1');
  });

  it('honours a custom (null) fallback so the adapter can reject unknown tenants', () => {
    expect(headerTenantResolver('x-tenant-id', null)(req({}))).toBeNull();
  });
});

describe('budget scope helpers', () => {
  it('builds a tenant scope', () => {
    expect(tenantBudgetScope('acme')).toEqual({ type: 'tenant', tenantId: 'acme' });
  });

  it('builds a tenant-agent scope', () => {
    expect(tenantAgentBudgetScope('acme', 'helpdesk')).toEqual({
      type: 'tenant-agent',
      tenantId: 'acme',
      agentName: 'helpdesk',
    });
  });
});
