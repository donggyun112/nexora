import { describe, it, expect } from 'vitest';
import { InMemoryBudgetTracker, estimateCostUsd } from '../budget.js';
import { createBudgetMiddleware, BudgetExceededError } from '../budget-middleware.js';
import type { CostEvent, BudgetPolicy } from '@dongkseo/contracts';

function makeEvent(overrides: Partial<CostEvent> = {}): CostEvent {
  return {
    agentName: 'test-agent',
    tenantId: 'tenant-A',
    model: 'claude-sonnet-4-5',
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.01,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('InMemoryBudgetTracker', () => {
  it('records events and accumulates spend', async () => {
    const tracker = new InMemoryBudgetTracker();
    await tracker.addPolicy({
      id: 'daily-A',
      scope: { type: 'tenant', tenantId: 'tenant-A' },
      maxCostUsd: 1.0,
      window: { type: 'daily' },
      onExceed: 'warn',
    });

    await tracker.record(makeEvent({ costUsd: 0.3 }));
    await tracker.record(makeEvent({ costUsd: 0.4 }));

    const spend = await tracker.getSpend(
      { type: 'tenant', tenantId: 'tenant-A' },
      { type: 'daily' },
    );
    expect(spend).toBeCloseTo(0.7, 2);
  });

  it('detects budget exceeded', async () => {
    const tracker = new InMemoryBudgetTracker();
    await tracker.addPolicy({
      id: 'tight',
      scope: { type: 'agent', agentName: 'test-agent' },
      maxCostUsd: 0.05,
      window: { type: 'daily' },
      onExceed: 'block',
    });

    const statuses1 = await tracker.record(makeEvent({ costUsd: 0.03 }));
    expect(statuses1[0].exceeded).toBe(false);
    expect(statuses1[0].remaining).toBeCloseTo(0.02, 2);

    const statuses2 = await tracker.record(makeEvent({ costUsd: 0.03 }));
    expect(statuses2[0].exceeded).toBe(true);
    expect(statuses2[0].remaining).toBe(0);
  });

  it('check() returns status without recording', async () => {
    const tracker = new InMemoryBudgetTracker();
    await tracker.addPolicy({
      id: 'p1',
      scope: { type: 'global' },
      maxCostUsd: 100,
      window: { type: 'monthly' },
      onExceed: 'warn',
    });

    await tracker.record(makeEvent({ costUsd: 5.0 }));

    const statuses = await tracker.check({ type: 'global' });
    expect(statuses).toHaveLength(1);
    expect(statuses[0].spent).toBeCloseTo(5.0, 1);
    expect(statuses[0].exceeded).toBe(false);
  });

  it('scopes correctly: tenant-A events dont count for tenant-B', async () => {
    const tracker = new InMemoryBudgetTracker();
    await tracker.addPolicy({
      id: 'a-only',
      scope: { type: 'tenant', tenantId: 'tenant-A' },
      maxCostUsd: 1.0,
      window: { type: 'daily' },
      onExceed: 'block',
    });

    await tracker.record(makeEvent({ tenantId: 'tenant-B', costUsd: 999 }));
    const statuses = await tracker.check({ type: 'tenant', tenantId: 'tenant-A' });
    expect(statuses[0].spent).toBe(0);
    expect(statuses[0].exceeded).toBe(false);
  });

  it('addPolicy replaces existing policy with same id', async () => {
    const tracker = new InMemoryBudgetTracker();
    await tracker.addPolicy({
      id: 'p1',
      scope: { type: 'global' },
      maxCostUsd: 10,
      window: { type: 'daily' },
      onExceed: 'warn',
    });
    await tracker.addPolicy({
      id: 'p1',
      scope: { type: 'global' },
      maxCostUsd: 20,
      window: { type: 'daily' },
      onExceed: 'block',
    });
    const policies = await tracker.listPolicies();
    expect(policies).toHaveLength(1);
    expect(policies[0].maxCostUsd).toBe(20);
  });

  it('removePolicy works', async () => {
    const tracker = new InMemoryBudgetTracker();
    await tracker.addPolicy({
      id: 'removeme',
      scope: { type: 'global' },
      maxCostUsd: 1,
      window: { type: 'daily' },
      onExceed: 'warn',
    });
    await tracker.removePolicy('removeme');
    expect(await tracker.listPolicies()).toHaveLength(0);
  });
});

describe('estimateCostUsd', () => {
  it('returns reasonable estimate for known models', () => {
    const cost = estimateCostUsd('claude-sonnet-4-5', 1000, 500);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.1);
  });

  it('falls back to default pricing for unknown models', () => {
    const cost = estimateCostUsd('unknown-model', 1000, 500);
    expect(cost).toBeGreaterThan(0);
  });
});

describe('createBudgetMiddleware', () => {
  it('blocks execution when budget is pre-exceeded', async () => {
    const tracker = new InMemoryBudgetTracker();
    await tracker.addPolicy({
      id: 'strict',
      scope: { type: 'tenant-agent', tenantId: 'tenant-A', agentName: 'my-agent' },
      maxCostUsd: 0.01,
      window: { type: 'daily' },
      onExceed: 'block',
    });
    // Pre-exhaust the budget
    await tracker.record(makeEvent({ agentName: 'my-agent', tenantId: 'tenant-A', costUsd: 0.02 }));

    const mw = createBudgetMiddleware({
      tracker,
      agentName: 'my-agent',
      tenantId: 'tenant-A',
    });

    await expect(
      mw.beforeExecution!({ tools: [], systemPrompt: '', input: {} }),
    ).rejects.toThrow(BudgetExceededError);
  });

  it('records cost after execution', async () => {
    const tracker = new InMemoryBudgetTracker();
    await tracker.addPolicy({
      id: 'tracking',
      scope: { type: 'agent', agentName: 'my-agent' },
      maxCostUsd: 100,
      window: { type: 'daily' },
      onExceed: 'warn',
    });

    const mw = createBudgetMiddleware({
      tracker,
      agentName: 'my-agent',
      tenantId: 'tenant-A',
    });

    await mw.afterExecution!({
      events: [{ type: 'tool_call' }, { type: 'tool_result' }, { type: 'done' }],
      finalContent: 'Hello world, this is a response.',
      input: {},
    });

    const spend = await tracker.getSpend(
      { type: 'agent', agentName: 'my-agent' },
      { type: 'daily' },
    );
    expect(spend).toBeGreaterThan(0);
  });
});
