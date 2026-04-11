import { describe, it, expect } from 'vitest';
import { createDelegateTool } from '../builtin/delegate.js';
import type {
  EventTransport,
  MessageEnvelope,
  RequestOptions,
  Subscription,
  TopicString,
  TransportDescription,
  AgentRegistry,
  AgentCard,
  ToolContext,
} from '@nexora/contracts';
import { matchTopic, messageId } from '@nexora/contracts';

class FakeTransport implements EventTransport {
  private readonly subs = new Map<number, { pattern: string; handler: (e: MessageEnvelope) => Promise<void> }>();
  private nextId = 0;

  describe(): TransportDescription {
    return { kind: 'fake', deliveryGuarantee: 'at-most-once', durable: false, supportsConsumerGroups: false };
  }

  async publish(envelope: MessageEnvelope): Promise<void> {
    const matched = Array.from(this.subs.values()).filter(s =>
      matchTopic(s.pattern, envelope.topic as TopicString),
    );
    for (const m of matched) await m.handler(envelope);
  }

  subscribe(pattern: string, handler: (e: MessageEnvelope) => Promise<void>): Subscription {
    const id = this.nextId++;
    this.subs.set(id, { pattern, handler });
    return { unsubscribe: () => { this.subs.delete(id); } };
  }

  async request(topic: TopicString, payload: unknown, options?: RequestOptions): Promise<MessageEnvelope> {
    const requestId = messageId();
    return new Promise<MessageEnvelope>((resolve, reject) => {
      let resolved = false;
      const sub = this.subscribe('#', async (incoming) => {
        if (resolved) return;
        if (incoming.metadata.replyTo === requestId) {
          resolved = true;
          sub.unsubscribe();
          clearTimeout(timer);
          resolve(incoming);
        }
      });
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        sub.unsubscribe();
        reject(new Error(`timeout`));
      }, options?.timeoutMs ?? 30_000);
      void this.publish({
        id: requestId, topic, type: 'request', payload,
        metadata: { traceId: 't', spanId: 's', conversationId: 'c', tenantId: options?.tenantId ?? 'default', timestamp: Date.now() },
      });
    });
  }

  async close(): Promise<void> { this.subs.clear(); }
}

function makeCtx(): ToolContext {
  return {
    tenantId: 'tenant-A', workdir: '/tmp',
    secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

function makeCard(name: string, capability: string, subscribes: string[]): AgentCard {
  return {
    name, version: '0.1.0', description: name,
    capabilities: [capability], subscribes, publishes: [],
    tools: [], architecture: 'echo',
  };
}

function makeRegistry(cards: AgentCard[]): AgentRegistry {
  return {
    register: async () => {},
    unregister: async () => {},
    get: async (n) => cards.find(c => c.name === n) ?? null,
    list: async () => [...cards],
    findByCapability: async (cap) => cards.filter(c => c.capabilities.includes(cap)),
    findBySubscription: async () => [],
  };
}

describe('delegate tool', () => {
  it('routes by capability and returns the target agent reply', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([makeCard('summarizer', 'summarize', ['summarize.requested'])]);

    transport.subscribe('summarize.requested', async (env) => {
      await transport.publish({
        id: messageId(), topic: 'summarize.completed', type: 'result',
        payload: { content: 'Summary: short version', toolCalls: [] },
        metadata: { ...env.metadata, replyTo: env.id, timestamp: Date.now() },
      });
    });

    const tool = createDelegateTool({ transport, registry });
    const result = await tool.execute('d-1', {
      capability: 'summarize',
      input: { prompt: 'summarize this doc' },
      timeoutMs: 2000,
    }, makeCtx());

    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('short version');
  });

  it('errors when no agent has the requested capability', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([]);
    const tool = createDelegateTool({ transport, registry });

    const result = await tool.execute('d-2', {
      capability: 'nonexistent',
      input: { prompt: 'x' },
    }, makeCtx());

    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/No agent/);
  });

  it('reports error when delegated agent returns { error }', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([makeCard('broken', 'break', ['break.requested'])]);

    transport.subscribe('break.requested', async (env) => {
      await transport.publish({
        id: messageId(), topic: 'break.done', type: 'result',
        payload: { error: 'agent exploded' },
        metadata: { ...env.metadata, replyTo: env.id, timestamp: Date.now() },
      });
    });

    const tool = createDelegateTool({ transport, registry });
    const result = await tool.execute('d-3', {
      capability: 'break',
      input: {},
      timeoutMs: 1000,
    }, makeCtx());

    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toContain('exploded');
  });

  it('refuses when delegation depth exceeds maxDepth', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([makeCard('a', 'do-thing', ['a.requested'])]);

    // maxDepth: 0 means no delegation allowed at all
    const tool = createDelegateTool({ transport, registry, maxDepth: 0 });
    const result = await tool.execute('d-4', {
      capability: 'do-thing',
      input: {},
    }, makeCtx());

    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/depth/i);
  });

  it('errors on timeout when target agent never replies', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([makeCard('slow', 'slow-work', ['slow.requested'])]);
    // No subscriber → request times out

    const tool = createDelegateTool({ transport, registry });
    const result = await tool.execute('d-5', {
      capability: 'slow-work',
      input: {},
      timeoutMs: 30,
    }, makeCtx());

    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/failed|timeout/i);
  });

  it('errors when capability and input are missing', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([]);
    const tool = createDelegateTool({ transport, registry });

    const r1 = await tool.execute('d-6', { input: {} }, makeCtx());
    expect(r1.type).toBe('error');

    const r2 = await tool.execute('d-7', { capability: 'x' }, makeCtx());
    expect(r2.type).toBe('error');
  });
});
