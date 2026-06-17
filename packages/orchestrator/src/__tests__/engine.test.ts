import { describe, it, expect } from 'vitest';
import { WorkflowEngine } from '../engine.js';
import type {
  Transport,
  Subscription,
  RequestOptions,
  TopicString,
  MessageEnvelope,
  WorkflowContract,
  TransportDescription,
} from '@dongkseo/contracts';
import { messageId } from '@dongkseo/contracts';

class StubTransport implements Transport {
  /** topic → handler returning the payload that should be sent back as reply */
  constructor(
    private readonly handlers: Map<string, (payload: unknown) => unknown | Promise<unknown>>,
  ) {}

  public callLog: { topic: string; payload: unknown }[] = [];

  describe(): TransportDescription {
    return {
      kind: 'stub',
      deliveryGuarantee: 'at-most-once',
      durable: false,
      supportsConsumerGroups: false,
    };
  }

  async publish(): Promise<void> {}

  subscribe(): Subscription {
    return { unsubscribe: () => {} };
  }

  async request(
    topic: TopicString,
    payload: unknown,
    _options?: RequestOptions,
  ): Promise<MessageEnvelope> {
    this.callLog.push({ topic: String(topic), payload });
    const handler = this.handlers.get(String(topic));
    if (!handler) throw new Error(`no handler for ${String(topic)}`);
    const result = await handler(payload);
    return {
      id: messageId(),
      topic: String(topic),
      type: 'result',
      payload: result,
      metadata: {
        traceId: 't',
        spanId: 's',
        conversationId: 'c',
        tenantId: 'default',
        timestamp: Date.now(),
      },
    };
  }

  async close(): Promise<void> {}
}

describe('WorkflowEngine', () => {
  it('rejects at-most-once transport when durable transport is required', () => {
    const transport = new StubTransport(new Map());
    expect(() => new WorkflowEngine({
      transport,
      requireDurableTransport: true,
    })).toThrow(/requires a DurableTransport|requires.*DurableTransport/i);
  });

  it('runs sequential steps and passes initial input via template', async () => {
    const handlers = new Map<string, (p: unknown) => unknown>([
      ['fetch.repo', (p) => ({ repo: (p as { name: string }).name, files: 12 })],
      ['analyze.code', (p) => ({ score: 95, repo: (p as { repo: string }).repo })],
    ]);
    const transport = new StubTransport(handlers);
    const engine = new WorkflowEngine({ transport });

    const workflow: WorkflowContract = {
      name: 'analyze',
      description: 'Fetch then analyze',
      trigger: { type: 'manual', command: 'analyze' },
      steps: [
        {
          id: 'fetch',
          topic: 'fetch.repo' as TopicString,
          input: { type: 'static', data: { name: 'nexora' } },
        },
        {
          id: 'analyze',
          topic: 'analyze.code' as TopicString,
          input: { type: 'fromStep', stepId: 'fetch' },
        },
      ],
    };

    const result = await engine.run(workflow);
    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].payload).toEqual({ repo: 'nexora', files: 12 });
    expect(result.steps[1].payload).toEqual({ score: 95, repo: 'nexora' });
  });

  it('uses fromStep with path extraction', async () => {
    const transport = new StubTransport(new Map<string, (p: unknown) => unknown>([
      ['a', () => ({ data: { value: 42 } })],
      ['b', (p) => ({ doubled: (p as number) * 2 })],
    ]));
    const engine = new WorkflowEngine({ transport });

    const workflow: WorkflowContract = {
      name: 'extract',
      description: '',
      trigger: { type: 'manual', command: 'x' },
      steps: [
        { id: 'a', topic: 'a' as TopicString, input: { type: 'static', data: {} } },
        { id: 'b', topic: 'b' as TopicString, input: { type: 'fromStep', stepId: 'a', path: 'data.value' } },
      ],
    };

    const result = await engine.run(workflow);
    expect(result.steps[1].payload).toEqual({ doubled: 84 });
  });

  it('takes onFailure transition (goto) and recovers', async () => {
    let firstCallFailed = false;
    const transport = new StubTransport(new Map<string, (p: unknown) => unknown>([
      ['try', () => {
        if (!firstCallFailed) {
          firstCallFailed = true;
          return { error: 'transient' };
        }
        return { ok: true };
      }],
      ['recover', () => ({ recovered: true })],
    ]));
    const engine = new WorkflowEngine({ transport });

    const workflow: WorkflowContract = {
      name: 'recover',
      description: '',
      trigger: { type: 'manual', command: 'r' },
      steps: [
        {
          id: 'try',
          topic: 'try' as TopicString,
          onFailure: { action: 'goto', stepId: 'recover' },
          onSuccess: { action: 'end' },
        },
        {
          id: 'recover',
          topic: 'recover' as TopicString,
          onSuccess: { action: 'goto', stepId: 'try' },
        },
      ],
    };

    const result = await engine.run(workflow);
    expect(result.status).toBe('completed');
    // try -> recover -> try
    expect(result.steps.map(s => s.stepId)).toEqual(['try', 'recover', 'try']);
  });

  it('retries failed requests up to maxAttempts', async () => {
    let calls = 0;
    const transport = new StubTransport(new Map<string, (p: unknown) => unknown>([
      ['flaky', () => {
        calls++;
        if (calls < 3) throw new Error(`fail ${calls}`);
        return { ok: true };
      }],
    ]));
    const engine = new WorkflowEngine({ transport });

    const workflow: WorkflowContract = {
      name: 'retry',
      description: '',
      trigger: { type: 'manual', command: 'r' },
      steps: [
        {
          id: 'flaky',
          topic: 'flaky' as TopicString,
          retry: { maxAttempts: 5, backoffMs: 0 },
        },
      ],
    };

    const result = await engine.run(workflow);
    expect(result.status).toBe('completed');
    expect(result.steps[0].attempts).toBe(3);
    expect(calls).toBe(3);
  });

  // Regression: agent failures returned as { error } payloads must also be retried.
  // Without this fix, the engine took onFailure on the first error payload and ignored maxAttempts.
  it('retries on { error } payloads, not just thrown transport errors', async () => {
    let calls = 0;
    const transport = new StubTransport(new Map<string, (p: unknown) => unknown>([
      ['agent', () => {
        calls++;
        if (calls < 3) return { error: `agent failed ${calls}` };
        return { ok: true };
      }],
    ]));
    const engine = new WorkflowEngine({ transport });

    const workflow: WorkflowContract = {
      name: 'retry-on-payload',
      description: '',
      trigger: { type: 'manual', command: 'x' },
      steps: [
        {
          id: 'agent',
          topic: 'agent' as TopicString,
          retry: { maxAttempts: 5, backoffMs: 0 },
        },
      ],
    };

    const result = await engine.run(workflow);
    expect(result.status).toBe('completed');
    expect(result.steps[0].attempts).toBe(3);
    expect(result.steps[0].isError).toBe(false);
    expect(calls).toBe(3);
  });

  it('returns last error payload after exhausting retries', async () => {
    const transport = new StubTransport(new Map<string, (p: unknown) => unknown>([
      ['always-error', () => ({ error: 'persistent failure' })],
    ]));
    const engine = new WorkflowEngine({ transport });

    const workflow: WorkflowContract = {
      name: 'exhaust',
      description: '',
      trigger: { type: 'manual', command: 'x' },
      steps: [
        {
          id: 'always-error',
          topic: 'always-error' as TopicString,
          retry: { maxAttempts: 3, backoffMs: 0 },
        },
      ],
    };

    const result = await engine.run(workflow);
    expect(result.status).toBe('failed');
    expect(result.steps[0].attempts).toBe(3);
    expect(result.steps[0].isError).toBe(true);
    expect((result.steps[0].payload as { error: string }).error).toBe('persistent failure');
  });

  it('fails on transport error after exhausting retries (no onFailure)', async () => {
    const transport = new StubTransport(new Map<string, (p: unknown) => unknown>([
      ['always-fail', () => { throw new Error('nope'); }],
    ]));
    const engine = new WorkflowEngine({ transport });

    const workflow: WorkflowContract = {
      name: 'fail',
      description: '',
      trigger: { type: 'manual', command: 'f' },
      steps: [
        { id: 'always-fail', topic: 'always-fail' as TopicString },
      ],
    };

    const result = await engine.run(workflow);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('failed');
    expect(result.steps[0].isError).toBe(true);
  });

  it('renders template input from context', async () => {
    const transport = new StubTransport(new Map<string, (p: unknown) => unknown>([
      ['greet', (p) => ({ msg: p })],
    ]));
    const engine = new WorkflowEngine({ transport });

    const workflow: WorkflowContract = {
      name: 'greet',
      description: '',
      trigger: { type: 'manual', command: 'g' },
      steps: [
        {
          id: 'greet',
          topic: 'greet' as TopicString,
          input: { type: 'template', template: 'Hello {{input.name}}' },
        },
      ],
    };

    const result = await engine.run(workflow, { input: { name: 'world' } });
    expect(result.steps[0].payload).toEqual({ msg: 'Hello world' });
  });
});
