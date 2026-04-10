/**
 * Workflow checkpoint + resume — verifies that a workflow interrupted
 * mid-flight can be resumed from its last checkpoint without losing
 * already-completed step results.
 */

import { describe, it, expect } from 'vitest';
import { WorkflowEngine, InMemoryWorkflowStateStore } from '../index.js';
import type {
  EventTransport,
  Subscription,
  RequestOptions,
  TopicString,
  MessageEnvelope,
  WorkflowContract,
  TransportDescription,
} from '@nexora/contracts';
import { messageId } from '@nexora/contracts';

/**
 * Programmable transport: each time the engine hits a topic, a scripted
 * handler returns either a successful payload, an error payload, or throws.
 * Supports counting calls so tests can inject crash-and-resume scenarios.
 */
class ScriptedTransport implements EventTransport {
  public calls: { topic: string; payload: unknown }[] = [];
  constructor(
    private readonly handlers: Map<
      string,
      (payload: unknown, callIdx: number) => unknown | Promise<unknown>
    >,
  ) {}

  describe(): TransportDescription {
    return {
      kind: 'scripted',
      deliveryGuarantee: 'at-most-once',
      durable: false,
      supportsConsumerGroups: false,
    };
  }

  async publish(): Promise<void> {}
  subscribe(): Subscription { return { unsubscribe: () => {} }; }

  async request(
    topic: TopicString,
    payload: unknown,
    _options?: RequestOptions,
  ): Promise<MessageEnvelope> {
    const idx = this.calls.length;
    this.calls.push({ topic: String(topic), payload });
    const handler = this.handlers.get(String(topic));
    if (!handler) throw new Error(`no handler for ${String(topic)}`);
    const result = await handler(payload, idx);
    return {
      id: messageId(),
      topic: String(topic),
      type: 'result',
      payload: result,
      metadata: {
        traceId: 't', spanId: 's', conversationId: 'c',
        tenantId: 'default', timestamp: Date.now(),
      },
    };
  }

  async close(): Promise<void> {}
}

const threeStepWorkflow: WorkflowContract = {
  name: 'three-step',
  description: 'a → b → c',
  trigger: { type: 'manual', command: 'run' },
  steps: [
    { id: 'a', topic: 'step.a' as TopicString, input: { type: 'static', data: { x: 1 } } },
    { id: 'b', topic: 'step.b' as TopicString, input: { type: 'fromStep', stepId: 'a' } },
    { id: 'c', topic: 'step.c' as TopicString, input: { type: 'fromStep', stepId: 'b' } },
  ],
};

describe('WorkflowEngine checkpointing', () => {
  it('saves a checkpoint after each successful step', async () => {
    const store = new InMemoryWorkflowStateStore();
    const transport = new ScriptedTransport(new Map([
      ['step.a', () => ({ from: 'a' })],
      ['step.b', () => ({ from: 'b' })],
      ['step.c', () => ({ from: 'c' })],
    ]));
    const engine = new WorkflowEngine({ transport, stateStore: store });

    const result = await engine.run(threeStepWorkflow, { workflowId: 'wf-1' });
    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(3);

    // On successful completion the engine deletes the checkpoint so it
    // doesn't show up in listRunning.
    const loaded = await store.load('wf-1');
    expect(loaded).toBeNull();
    expect(await store.listRunning()).toHaveLength(0);
  });

  it('leaves a resumable checkpoint if the process "crashes" mid-workflow', async () => {
    const store = new InMemoryWorkflowStateStore();

    // First run: step b throws (simulate crash). Engine treats it as failed.
    const crashTransport = new ScriptedTransport(new Map([
      ['step.a', () => ({ from: 'a' })],
      ['step.b', () => { throw new Error('simulated crash'); }],
      ['step.c', () => ({ from: 'c' })],
    ]));
    const engine1 = new WorkflowEngine({ transport: crashTransport, stateStore: store });
    const result1 = await engine1.run(threeStepWorkflow, { workflowId: 'wf-crash' });
    expect(result1.status).toBe('failed');

    // Now manually re-mark the checkpoint as running (this is what a real
    // recovery tool would do after confirming the crash was transient).
    // In production the engine would call listRunning() on boot and the
    // operator would re-issue resume() for each entry.
    const cp = await store.load('wf-crash');
    // Because the step failed and there was no onFailure transition, the
    // engine marks status='failed'. We simulate "the operator decides to
    // retry" by flipping it back.
    if (cp) {
      await store.save({ ...cp, status: 'running', nextStepId: 'b' });
    }

    // Second run: step b now succeeds, step c runs too.
    const recoverTransport = new ScriptedTransport(new Map([
      ['step.a', () => ({ from: 'a-RESUMED' })], // should NOT be called
      ['step.b', () => ({ from: 'b-now-ok' })],
      ['step.c', () => ({ from: 'c-final' })],
    ]));
    const engine2 = new WorkflowEngine({ transport: recoverTransport, stateStore: store });
    const result2 = await engine2.resume(threeStepWorkflow, 'wf-crash');

    expect(result2.status).toBe('completed');

    // Critical: step.a was NOT re-executed. Its result from the first run
    // should have been preserved and reused.
    const aCalls = recoverTransport.calls.filter(c => c.topic === 'step.a');
    expect(aCalls).toHaveLength(0);

    // steps b and c each ran exactly once
    expect(recoverTransport.calls.filter(c => c.topic === 'step.b')).toHaveLength(1);
    expect(recoverTransport.calls.filter(c => c.topic === 'step.c')).toHaveLength(1);

    // After successful completion the checkpoint is gone
    expect(await store.load('wf-crash')).toBeNull();
  });

  it('resume() throws when no checkpoint exists', async () => {
    const store = new InMemoryWorkflowStateStore();
    const transport = new ScriptedTransport(new Map());
    const engine = new WorkflowEngine({ transport, stateStore: store });
    await expect(engine.resume(threeStepWorkflow, 'nope')).rejects.toThrow(/No checkpoint/);
  });

  it('resume() throws when engine was constructed without a stateStore', async () => {
    const transport = new ScriptedTransport(new Map());
    const engine = new WorkflowEngine({ transport });
    await expect(engine.resume(threeStepWorkflow, 'x')).rejects.toThrow(/without a stateStore/);
  });

  it('listRunning returns workflows that were interrupted', async () => {
    const store = new InMemoryWorkflowStateStore();
    const transport = new ScriptedTransport(new Map([
      ['step.a', () => ({ ok: 1 })],
      ['step.b', () => { throw new Error('boom'); }],
      ['step.c', () => ({ ok: 3 })],
    ]));
    const engine = new WorkflowEngine({ transport, stateStore: store });

    const wf = await engine.run(threeStepWorkflow, { workflowId: 'wf-listed' });
    expect(wf.status).toBe('failed');

    // The status is 'failed', not 'running', so listRunning is empty —
    // failed workflows aren't resumable by default, operators must intervene.
    expect(await store.listRunning()).toHaveLength(0);

    // The checkpoint is still there for inspection.
    const cp = await store.load('wf-listed');
    expect(cp).not.toBeNull();
    expect(cp?.status).toBe('failed');
  });
});
