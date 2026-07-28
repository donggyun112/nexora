import { describe, it, expect } from 'vitest';
import {
  decide,
  mergeRules,
  createGroupPolicyResolver,
  type PolicyRules,
} from '../handraise/approval-policy.js';
import type { ApprovalGatePolicyContext } from '../handraise/approval-middleware.js';

const emptyRules: PolicyRules = { byDomain: {}, byAction: {} };

function makeCtx(policyGroup: string): ApprovalGatePolicyContext {
  return {
    tool: { name: 't', description: '', parameters: {}, execute: async () => ({ type: 'ok' }) } as never,
    toolName: 't',
    input: {},
    policyGroup,
    policyGroups: [policyGroup],
    channel: 'test',
    tenantId: 'default',
    sessionKey: 'sess',
  };
}

describe('decide', () => {
  it('matches on the domain axis', () => {
    const rules: PolicyRules = { byDomain: { outline: 'ask' }, byAction: {} };
    expect(decide(rules, 'outline.write')).toBe('ask');
  });

  it('matches on the action axis', () => {
    const rules: PolicyRules = { byDomain: {}, byAction: { delete: 'deny' } };
    expect(decide(rules, 'fs.delete')).toBe('deny');
  });

  it('lets the more restrictive axis win when both match', () => {
    const rules: PolicyRules = { byDomain: { outline: 'ask' }, byAction: { write: 'block' } };
    // block (2) > ask (1) → block wins
    expect(decide(rules, 'outline.write')).toBe('block');
  });

  it('returns skip when nothing matches', () => {
    expect(decide(emptyRules, 'outline.write')).toBe('skip');
  });

  it('treats a dotless group as an action-axis key', () => {
    const rules: PolicyRules = { byDomain: {}, byAction: { requires_review: 'ask' } };
    expect(decide(rules, 'requires_review')).toBe('ask');
  });

  it('picks deny over block over ask', () => {
    const rules: PolicyRules = { byDomain: { pay: 'block' }, byAction: { refund: 'deny' } };
    expect(decide(rules, 'pay.refund')).toBe('deny');
  });
});

describe('mergeRules', () => {
  it('lets the later source override the earlier per key', () => {
    const base: PolicyRules = { byDomain: { outline: 'ask' }, byAction: {} };
    const over: PolicyRules = { byDomain: { outline: 'deny' }, byAction: {} };
    expect(mergeRules(base, over).byDomain.outline).toBe('deny');
  });

  it('unions keys from both sources', () => {
    const base: PolicyRules = { byDomain: { a: 'ask' }, byAction: {} };
    const over: PolicyRules = { byDomain: { b: 'block' }, byAction: {} };
    const merged = mergeRules(base, over);
    expect(merged.byDomain).toEqual({ a: 'ask', b: 'block' });
  });

  it('prefers the later mode, falling back to the earlier', () => {
    expect(mergeRules({ ...emptyRules, mode: 'ask' }, { ...emptyRules, mode: 'block' }).mode).toBe('block');
    expect(mergeRules({ ...emptyRules, mode: 'ask' }, emptyRules).mode).toBe('ask');
  });
});

describe('createGroupPolicyResolver', () => {
  it('resolves the context policyGroup through decide', async () => {
    const resolver = createGroupPolicyResolver({ byDomain: { outline: 'deny' }, byAction: {} });
    expect(await resolver(makeCtx('outline.write'))).toBe('deny');
  });

  it('returns skip for an unmatched group', async () => {
    const resolver = createGroupPolicyResolver(emptyRules);
    expect(await resolver(makeCtx('anything.here'))).toBe('skip');
  });
});
