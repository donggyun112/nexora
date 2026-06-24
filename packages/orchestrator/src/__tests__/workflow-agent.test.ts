import { describe, it, expect } from 'vitest';
import { topic, type WorkflowContract } from '@dongkseo/contracts';
import { workflowCard, bootstrapWorkflow, type BootstrapAgentFn } from '../workflow-agent.js';
import { CronScheduler } from '../cron.js';
import type { WorkflowRunnerLike } from '../workflow-runtime.js';
import type { WorkflowExecutionResult } from '../engine.js';

function wf(overrides: Partial<WorkflowContract> = {}): WorkflowContract {
  return {
    name: 'wf1',
    description: 'test workflow',
    trigger: { type: 'manual', command: 'go' },
    steps: [{ id: 's1', topic: topic('a.b') }],
    ...overrides,
  };
}

const completed: WorkflowExecutionResult = {
  workflow: 'wf1', status: 'completed', steps: [],
};

interface RunCapture { workflow?: WorkflowContract; input?: { input?: unknown } }
function fakeRunner(cap: RunCapture = {}): WorkflowRunnerLike {
  return {
    async run(workflow, input) {
      cap.workflow = workflow;
      cap.input = input ?? {};
      return { ...completed, workflow: workflow.name };
    },
  };
}

interface BootstrapCapture {
  options?: Parameters<BootstrapAgentFn>[0];
  shutdownCalls: number;
}
function fakeBootstrap(cap: BootstrapCapture): BootstrapAgentFn {
  return async (options) => {
    cap.options = options;
    return { shutdown: async () => { cap.shutdownCalls++; } };
  };
}

describe('workflowCard', () => {
  it('builds a card subscribing to the topic trigger', () => {
    const card = workflowCard(wf({ name: 'orderflow', trigger: { type: 'topic', topic: topic('order.placed') } }));
    expect(card.name).toBe('orderflow');
    expect(card.description).toBe('test workflow');
    expect(card.subscribes).toEqual(['order.placed']);
    expect(card.architecture).toBe('workflow');
    expect(card.tools).toEqual([]);
  });

  it('subscribes to nothing for a non-topic trigger', () => {
    const card = workflowCard(wf({ trigger: { type: 'cron', expression: '* * * * *' } }));
    expect(card.subscribes).toEqual([]);
  });

  it('merges overrides (capabilities, version, publishes)', () => {
    const card = workflowCard(wf({ trigger: { type: 'topic', topic: topic('x.y') } }), {
      capabilities: ['cap-a'],
      version: '2.0.0',
      publishes: [topic('x.done')],
    });
    expect(card.capabilities).toEqual(['cap-a']);
    expect(card.version).toBe('2.0.0');
    expect(card.publishes).toEqual(['x.done']);
  });
});

describe('bootstrapWorkflow', () => {
  it('topic trigger: bootstraps an agent whose card subscribes to the topic', async () => {
    const cap: BootstrapCapture = { shutdownCalls: 0 };
    const handle = await bootstrapWorkflow({
      workflow: wf({ name: 'orderflow', trigger: { type: 'topic', topic: topic('order.placed') } }),
      engine: fakeRunner(),
      transport: {} as never,
      contextLoader: {} as never,
      bootstrapAgent: fakeBootstrap(cap),
      cardOverrides: { capabilities: ['process-order'] },
    });

    expect(cap.options?.card.subscribes).toEqual(['order.placed']);
    expect(cap.options?.card.capabilities).toEqual(['process-order']);

    // The createRuntime passed to bootstrapAgent yields a workflow runtime.
    const rt = await cap.options!.createRuntime({ context: {}, envelope: {} } as never);
    expect(typeof rt.execute).toBe('function');

    await handle.shutdown();
    expect(cap.shutdownCalls).toBe(1);
  });

  it('cron trigger: schedules a job that runs the workflow, unscheduled on shutdown', async () => {
    const scheduler = new CronScheduler();
    const runCap: RunCapture = {};
    const handle = await bootstrapWorkflow({
      workflow: wf({ name: 'nightly', trigger: { type: 'cron', expression: '0 0 * * *' } }),
      engine: fakeRunner(runCap),
      transport: {} as never,
      scheduler,
      nextRunAt: (now) => now + 100_000,
    });

    expect(scheduler.list()).toContain('workflow:nightly');
    await scheduler.trigger('workflow:nightly');
    expect(runCap.workflow?.name).toBe('nightly');

    await handle.shutdown();
    expect(scheduler.list()).not.toContain('workflow:nightly');
  });

  it('cron trigger without scheduler/nextRunAt throws a clear error', async () => {
    await expect(
      bootstrapWorkflow({
        workflow: wf({ trigger: { type: 'cron', expression: 'x' } }),
        engine: fakeRunner(),
        transport: {} as never,
      }),
    ).rejects.toThrow(/cron/i);
  });

  it('manual trigger: no agent bootstrap, exposes a run() handle', async () => {
    const cap: BootstrapCapture = { shutdownCalls: 0 };
    const runCap: RunCapture = {};
    const handle = await bootstrapWorkflow({
      workflow: wf({ name: 'manualflow', trigger: { type: 'manual', command: 'go' } }),
      engine: fakeRunner(runCap),
      transport: {} as never,
      bootstrapAgent: fakeBootstrap(cap),
    });

    expect(cap.options).toBeUndefined();
    expect(typeof handle.run).toBe('function');
    await handle.run!({ foo: 1 });
    expect(runCap.input?.input).toEqual({ foo: 1 });
  });
});
