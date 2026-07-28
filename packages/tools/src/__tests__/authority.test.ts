import { describe, it, expect } from 'vitest';
import { attenuate, createEscalationGuard } from '../handraise/authority.js';
import type { ApprovalGatePolicyContext } from '../handraise/approval-middleware.js';

function ctx(policyGroup: string): ApprovalGatePolicyContext {
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

describe('attenuate', () => {
  it('narrows a child to the intersection of parent and requested', () => {
    expect(attenuate(['A', 'B'], ['A'])).toEqual(['A']);
  });

  it('never lets a child gain a group the parent lacks (no escalation)', () => {
    expect(attenuate(['A'], ['A', 'B'])).toEqual(['A']);
  });

  it('inherits the full parent set when the child requests nothing', () => {
    expect(attenuate(['A', 'B'], undefined)).toEqual(['A', 'B']);
  });

  it('stays a subset transitively (grandchild ⊆ child ⊆ parent)', () => {
    const child = attenuate(['A', 'B'], ['A']);
    const grandchild = attenuate(child, ['A', 'B']);
    expect(grandchild).toEqual(['A']);
  });

  it('treats an undefined parent as root/unrestricted', () => {
    expect(attenuate(undefined, ['A'])).toEqual(['A']);
    expect(attenuate(undefined, undefined)).toBeUndefined();
  });
});

describe('createEscalationGuard', () => {
  it('denies a group outside the inherited authority', async () => {
    const guard = createEscalationGuard(['A']);
    expect(await guard(ctx('B'))).toBe('deny');
  });

  it('allows a group within the inherited authority', async () => {
    const guard = createEscalationGuard(['A']);
    expect(await guard(ctx('A'))).toBe('skip');
  });

  it('imposes no constraint when authority is unrestricted (root)', async () => {
    const guard = createEscalationGuard(undefined);
    expect(await guard(ctx('anything'))).toBe('skip');
  });
});
