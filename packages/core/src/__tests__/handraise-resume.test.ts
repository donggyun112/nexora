/**
 * Bootstrap handraise suspend/resume integration test.
 *
 * Verifies that a turn which suspends (e.g. handraise asked a human) is parked
 * — NOT published as a result — its state persisted, and then resumed and
 * completed when the answer arrives on the reply topic. Crucially there is no
 * wall-clock deadline: the answer can arrive arbitrarily late.
 */

import { describe, it, expect } from 'vitest';
import { bootstrapAgent } from '../bootstrap.js';
import type {
  EventTransport,
  Subscription,
  TopicString,
  TransportDescription,
  MessageEnvelope,
  AgentCard,
  ContextLoader,
  AgentContext,
  AgentRuntime,
  AgentInput,
  RuntimeServices,
  SuspendedTurnStore,
  SuspendedTurnState,
} from '@dongkseo/contracts';
import { matchTopic } from '@dongkseo/contracts';

class InlineTransport implements EventTransport {
  private subs = new Map<number, { pattern: string; handler: (e: MessageEnvelope) => Promise<void> }>();
  private nextId = 0;
  public readonly published: MessageEnvelope[] = [];

  describe(): TransportDescription {
    return {
      kind: 'inline-test',
      deliveryGuarantee: 'at-most-once',
      durable: false,
      supportsConsumerGroups: false,
      notes: 'synchronous in-test transport',
    };
  }

  async publish(env: MessageEnvelope): Promise<void> {
    this.published.push(env);
    const matched = Array.from(this.subs.values()).filter(s =>
      matchTopic(s.pattern, env.topic as TopicString),
    );
    await Promise.all(matched.map(s => s.handler(env)));
  }

  subscribe(pattern: string, handler: (e: MessageEnvelope) => Promise<void>): Subscription {
    const id = this.nextId++;
    this.subs.set(id, { pattern, handler });
    return { unsubscribe: () => { this.subs.delete(id); } };
  }

  async req(): Promise<MessageEnvelope> {
    throw new Error('not used in this test');
  }

  async close(): Promise<void> {
    this.subs.clear();
  }
}

class MapSuspendedTurnStore implements SuspendedTurnStore {
  public readonly turns = new Map<string, SuspendedTurnState>();
  async save(s: SuspendedTurnState): Promise<void> { this.turns.set(s.pendingId, s); }
  async claim(id: string): Promise<SuspendedTurnState | null> {
    const state = this.turns.get(id);
    if (!state || state.status !== 'awaiting') return null;
    const claimed: SuspendedTurnState = { ...state, status: 'resumed' };
    this.turns.set(id, claimed);
    return claimed;
  }
  async release(id: string): Promise<boolean> {
    const state = this.turns.get(id);
    if (!state || state.status !== 'resumed') return false;
    this.turns.set(id, { ...state, status: 'awaiting' });
    return true;
  }
  async load(id: string): Promise<SuspendedTurnState | null> { return this.turns.get(id) ?? null; }
  async delete(id: string): Promise<void> { this.turns.delete(id); }
  async listAwaiting(): Promise<SuspendedTurnState[]> {
    return Array.from(this.turns.values()).filter(s => s.status === 'awaiting');
  }
}

const loader: ContextLoader = { load: async (tenantId) => ({ tenantId } as AgentContext) };

const card: AgentCard = {
  name: 'asker',
  version: '0.1.0',
  description: 'asks humans',
  capabilities: [],
  subscribes: ['task.requested'],
  publishes: ['task.completed'],
  tools: ['handraise'],
  architecture: 'react',
};

function makeRequest(): MessageEnvelope {
  return {
    id: 'req-1',
    topic: 'task.requested',
    type: 'request',
    payload: { prompt: 'plan the deploy' },
    metadata: { traceId: 't', spanId: 's', conversationId: 'c', tenantId: 'default', timestamp: 1 },
  };
}

// Stub runtime: suspends on the initial turn (mimicking handraise(human)),
// completes on resume by echoing the injected answer.
function makeCreateRuntime(onResume?: () => void) {
  return ({ onSuspend }: {
    context: AgentContext;
    envelope: MessageEnvelope;
    onSuspend?: RuntimeServices['onSuspend'];
  }): AgentRuntime => ({
    async *execute(input: AgentInput) {
      if (input.resumeContext) {
        onResume?.();
        const tr = input.resumeContext.toolResult;
        const text = tr.type === 'text' ? tr.text : JSON.stringify(tr);
        yield { type: 'done', content: `resumed-with: ${text}`, toolCalls: [] };
      } else {
        await onSuspend?.({
          pendingId: 'p1',
          toolCallId: 'tc1',
          architectureHistory: [{ role: 'assistant', content: 'asked the human' }],
          completedResults: [],
        });
        yield { type: 'suspended', pendingId: 'p1', toolCallId: 'tc1' };
      }
    },
    abort() {},
  });
}

const toAgentInput = (env: MessageEnvelope): AgentInput => ({
  prompt: String((env.payload as { prompt?: string }).prompt ?? ''),
});

describe('bootstrap — handraise suspend/resume', () => {
  it('parks a suspended turn and resumes it when the answer arrives (no timeout)', async () => {
    const transport = new InlineTransport();
    const store = new MapSuspendedTurnStore();

    const agent = await bootstrapAgent({
      card,
      contextLoader: loader,
      transport,
      suspendedTurnStore: store,
      createRuntime: makeCreateRuntime(),
      toAgentInput,
    });

    // 1) Initial request → the turn suspends.
    await transport.publish(makeRequest());

    // No result yet — the turn is parked and persisted, not completed.
    expect(transport.published.find(e => e.topic === 'task.completed')).toBeUndefined();
    expect(store.turns.size).toBe(1);
    const parked = store.turns.get('p1')!;
    expect(parked.resultTopic).toBe('task.completed');
    expect(parked.envelope.id).toBe('req-1');
    expect(parked.architectureHistory.length).toBe(1);

    // 2) The human answers — arbitrarily later, well past any old 5-min deadline.
    await new Promise(r => setTimeout(r, 25));
    await transport.publish({
      id: 'ans-1',
      topic: 'handraise.human.default.answered',
      type: 'result',
      payload: { answer: 'ship to prod' },
      metadata: { traceId: 't', spanId: 's2', conversationId: 'c', replyTo: 'p1', tenantId: 'default', timestamp: 2 },
    });

    // 3) The parked turn resumed and published to the ORIGINAL result topic,
    //    correlated back to the original request, carrying the answer.
    const completed = transport.published.find(e => e.topic === 'task.completed');
    expect(completed).toBeDefined();
    expect(completed!.metadata.replyTo).toBe('req-1');
    expect((completed!.payload as { content?: string }).content).toContain('ship to prod');

    // 4) The store entry was consumed.
    expect(store.turns.size).toBe(0);

    await agent.shutdown();
  });

  it('checkpoints the parked call and hands resume both the formatted result and the raw answer', async () => {
    const transport = new InlineTransport();
    const store = new MapSuspendedTurnStore();
    let seen: AgentInput['resumeContext'] | undefined;

    const agent = await bootstrapAgent({
      card,
      contextLoader: loader,
      transport,
      suspendedTurnStore: store,
      createRuntime: ({ onSuspend }): AgentRuntime => ({
        async *execute(input: AgentInput) {
          if (input.resumeContext) {
            seen = input.resumeContext;
            yield { type: 'done', content: 'resumed', toolCalls: [] };
          } else {
            await onSuspend?.({
              pendingId: 'p1',
              toolCallId: 'tc1',
              architectureHistory: [{ role: 'assistant', content: 'asked the human' }],
              completedResults: [],
              call: { name: 'rm', input: { path: 'a.txt' } },
            });
            yield { type: 'suspended', pendingId: 'p1', toolCallId: 'tc1' };
          }
        },
        abort() {},
      }),
      toAgentInput,
    });

    await transport.publish(makeRequest());
    expect(store.turns.get('p1')?.call).toEqual({ name: 'rm', input: { path: 'a.txt' } });

    await transport.publish({
      id: 'ans-1',
      topic: 'handraise.human.default.answered',
      type: 'result',
      payload: { answer: 'approve', rationale: 'looks safe' },
      metadata: { traceId: 't', spanId: 's2', conversationId: 'c', replyTo: 'p1', tenantId: 'default', timestamp: 2 },
    });

    // The gate reads the raw answer; the no-gate path keeps using toolResult.
    expect(seen?.resumedCall).toEqual({ name: 'rm', input: { path: 'a.txt' } });
    expect(seen?.resumeAnswer).toEqual({ pendingId: 'p1', answer: 'approve', rationale: 'looks safe' });
    expect(seen?.toolResult).toEqual({ type: 'text', text: 'approve\n\n[rationale] looks safe' });

    await agent.shutdown();
  });

  it('publishes a gate question only AFTER the park is persisted', async () => {
    const transport = new InlineTransport();
    const store = new MapSuspendedTurnStore();
    const order: string[] = [];
    const save = store.save.bind(store);
    store.save = async (s) => { order.push('save'); await save(s); };
    const publish = transport.publish.bind(transport);
    transport.publish = async (env) => {
      if (env.topic === 'handraise.human.default') order.push('publish');
      await publish(env);
    };

    const agent = await bootstrapAgent({
      card,
      contextLoader: loader,
      transport,
      suspendedTurnStore: store,
      createRuntime: ({ onSuspend }): AgentRuntime => ({
        async *execute() {
          await onSuspend?.({
            pendingId: 'p1',
            toolCallId: 'tc1',
            architectureHistory: [{ role: 'assistant', content: 'gated' }],
            completedResults: [],
            call: { name: 'rm', input: { path: 'a.txt' } },
            request: {
              topic: 'handraise.human.default',
              payload: { question: 'Approve: rm a.txt', callId: 'tc1' },
            },
          });
          yield { type: 'suspended', pendingId: 'p1', toolCallId: 'tc1' };
        },
        abort() {},
      }),
      toAgentInput,
    });

    await transport.publish(makeRequest());

    // The order IS the fix: publishing first leaves an orphaned question behind
    // whenever the process dies before the park is written.
    expect(order).toEqual(['save', 'publish']);
    const asked = transport.published.find(e => e.topic === 'handraise.human.default');
    expect(asked).toBeDefined();
    // The reply correlates by metadata.replyTo == this id, so it must be the pendingId.
    expect(asked!.id).toBe('p1');
    expect(asked!.payload).toEqual({ question: 'Approve: rm a.txt', callId: 'tc1', pendingId: 'p1' });
    expect(asked!.metadata.tenantId).toBe('default');

    await agent.shutdown();
  });

  it('publishes nothing extra when the tool suspended itself', async () => {
    const transport = new InlineTransport();
    const store = new MapSuspendedTurnStore();
    const agent = await bootstrapAgent({
      card,
      contextLoader: loader,
      transport,
      suspendedTurnStore: store,
      // makeCreateRuntime's onSuspend carries no `request` — the handraise tool
      // already published its own question.
      createRuntime: makeCreateRuntime(),
      toAgentInput,
    });

    await transport.publish(makeRequest());

    expect(store.turns.get('p1')).toBeDefined();
    expect(transport.published.map(e => e.topic)).toEqual(['task.requested']);

    await agent.shutdown();
  });

  it('ignores a reply whose pendingId is unknown (duplicate / not ours)', async () => {
    const transport = new InlineTransport();
    const store = new MapSuspendedTurnStore();
    const agent = await bootstrapAgent({
      card,
      contextLoader: loader,
      transport,
      suspendedTurnStore: store,
      createRuntime: makeCreateRuntime(),
      toAgentInput,
    });

    await transport.publish({
      id: 'ans-x',
      topic: 'handraise.human.default.answered',
      type: 'result',
      payload: { answer: 'noise' },
      metadata: { traceId: 't', spanId: 's', conversationId: 'c', replyTo: 'nope', tenantId: 'default', timestamp: 1 },
    });

    expect(transport.published.find(e => e.topic === 'task.completed')).toBeUndefined();
    await agent.shutdown();
  });

  it('atomically claims a parked turn so concurrent duplicate answers resume it once', async () => {
    const transport = new InlineTransport();
    const store = new MapSuspendedTurnStore();
    let resumeCount = 0;
    const agent = await bootstrapAgent({
      card,
      contextLoader: loader,
      transport,
      suspendedTurnStore: store,
      createRuntime: makeCreateRuntime(() => { resumeCount += 1; }),
      toAgentInput,
    });

    await transport.publish(makeRequest());
    const answer = (id: string): MessageEnvelope => ({
      id,
      topic: 'handraise.human.default.answered',
      type: 'result',
      payload: { answer: 'ship to prod' },
      metadata: { traceId: 't', spanId: id, conversationId: 'c', replyTo: 'p1', tenantId: 'default', timestamp: 2 },
    });

    await Promise.all([
      transport.publish(answer('ans-1')),
      transport.publish(answer('ans-2')),
    ]);

    expect(resumeCount).toBe(1);
    expect(transport.published.filter(e => e.topic === 'task.completed')).toHaveLength(1);
    expect(store.turns.size).toBe(0);
    await agent.shutdown();
  });

  it('returns a failed resume to awaiting so a later delivery can retry it', async () => {
    const transport = new InlineTransport();
    const store = new MapSuspendedTurnStore();
    const agent = await bootstrapAgent({
      card,
      contextLoader: loader,
      transport,
      suspendedTurnStore: store,
      createRuntime: makeCreateRuntime(() => { throw new Error('resume boom'); }),
      toAgentInput,
    });

    const request = makeRequest();
    request.metadata._replyStream = 'reply:request-1';
    await transport.publish(request);
    await transport.publish({
      id: 'ans-1',
      topic: 'handraise.human.default.answered',
      type: 'result',
      payload: { answer: 'ship to prod' },
      metadata: { traceId: 't', spanId: 's2', conversationId: 'c', replyTo: 'p1', tenantId: 'default', timestamp: 2 },
    });

    expect(transport.published.find(e => e.topic === 'task.completed.failed')).toBeDefined();
    expect(transport.published.find(e => e.topic === 'reply:request-1')).toMatchObject({
      payload: { error: 'resume boom' },
    });
    expect(store.turns.get('p1')?.status).toBe('awaiting');
    await agent.shutdown();
  });
});
