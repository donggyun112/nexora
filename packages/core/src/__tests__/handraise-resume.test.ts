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
function makeCreateRuntime() {
  return ({ onSuspend }: {
    context: AgentContext;
    envelope: MessageEnvelope;
    onSuspend?: RuntimeServices['onSuspend'];
  }): AgentRuntime => ({
    async *execute(input: AgentInput) {
      if (input.resumeContext) {
        const tr = input.resumeContext.toolResult;
        const text = tr.type === 'text' ? tr.text : JSON.stringify(tr);
        yield { type: 'done', content: `resumed-with: ${text}`, toolCalls: [] };
      } else {
        await onSuspend?.({
          pendingId: 'p1',
          toolCallId: 'tc1',
          architectureHistory: [{ role: 'assistant', content: 'asked the human' }],
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
});
