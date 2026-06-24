import { describe, it, expect } from 'vitest';
import { topic, type WorkflowContract, type AgentEvent } from '@dongkseo/contracts';
import { createWorkflowRuntime, type WorkflowRunnerLike } from '../workflow-runtime.js';
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
  workflow: 'wf1',
  status: 'completed',
  steps: [{ stepId: 's1', topic: 'a.b', payload: { ok: true }, isError: false, attempts: 1 }],
};

interface Capture {
  workflow?: WorkflowContract;
  input?: { input?: unknown };
}

function fakeRunner(result: WorkflowExecutionResult, cap: Capture = {}): WorkflowRunnerLike {
  return {
    async run(workflow, input) {
      cap.workflow = workflow;
      cap.input = input ?? {};
      return result;
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('createWorkflowRuntime', () => {
  it('runs the workflow and emits a done event on completion', async () => {
    const rt = createWorkflowRuntime(fakeRunner(completed), wf());
    const events = await drain(rt.execute({ prompt: '{}' }));
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(JSON.parse((done as { content: string }).content).status).toBe('completed');
  });

  it('emits an error event when the workflow fails', async () => {
    const failed: WorkflowExecutionResult = {
      workflow: 'wf1', status: 'failed', steps: [], error: 'boom',
    };
    const rt = createWorkflowRuntime(fakeRunner(failed), wf());
    const events = await drain(rt.execute({ prompt: '' }));
    expect(events.some((e) => e.type === 'error' && e.message.includes('boom'))).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('default input mapping parses a JSON prompt into the workflow input', async () => {
    const cap: Capture = {};
    const rt = createWorkflowRuntime(fakeRunner(completed, cap), wf());
    await drain(rt.execute({ prompt: '{"x":1}' }));
    expect(cap.input?.input).toEqual({ x: 1 });
  });

  it('default input mapping passes a non-JSON prompt through as a string', async () => {
    const cap: Capture = {};
    const rt = createWorkflowRuntime(fakeRunner(completed, cap), wf());
    await drain(rt.execute({ prompt: 'just text' }));
    expect(cap.input?.input).toBe('just text');
  });

  it('honors a custom toWorkflowInput mapper', async () => {
    const cap: Capture = {};
    const rt = createWorkflowRuntime(fakeRunner(completed, cap), wf(), {
      toWorkflowInput: (input) => ({ derived: input.prompt.length }),
    });
    await drain(rt.execute({ prompt: 'abcd' }));
    expect(cap.input?.input).toEqual({ derived: 4 });
  });

  it('emits a progress event per step', async () => {
    const rt = createWorkflowRuntime(fakeRunner(completed), wf());
    const events = await drain(rt.execute({ prompt: '{}' }));
    expect(events.filter((e) => e.type === 'progress')).toHaveLength(1);
  });
});
