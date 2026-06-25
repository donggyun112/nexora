import { describe, it, expect } from 'vitest';
import { createDelegateTool, __drainRuntimeForTest as drainRuntime } from '../builtin/delegate.js';
import { InMemoryApprovalPolicyStore } from '../handraise/index.js';
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
  AgentRuntime,
  AgentInput,
  AgentEvent,
} from '@dongkseo/contracts';
import { matchTopic, messageId } from '@dongkseo/contracts';

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

  it('fire-forget (waitForResult=false) publishes a request envelope without waiting', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([
      makeCard('writer', 'write', ['write.requested']),
    ]);
    const tool = createDelegateTool({
      transport,
      registry,
      callerAgentName: 'caller-A',
    });

    let received: MessageEnvelope | undefined;
    transport.subscribe('write.requested', async (env) => {
      received = env;
      // intentionally do not reply — should not block the call below
    });

    const result = await tool.execute(
      'd-ff',
      { capability: 'write', input: { topic: 'x' }, waitForResult: false },
      makeCtx(),
    );

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toMatch(/fire-and-forget/i);
    }
    expect(received).toBeDefined();
    expect(received?.metadata.callerAgent).toBe('caller-A');
  });

  it('async (waitForResult="async") publishes and returns immediately with correlation id', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([
      makeCard('writer', 'write', ['write.requested']),
    ]);
    const tool = createDelegateTool({
      transport,
      registry,
      callerAgentName: 'caller-A',
    });

    let received: MessageEnvelope | undefined;
    transport.subscribe('write.requested', async (env) => {
      received = env;
    });

    const result = await tool.execute(
      'd-async',
      { capability: 'write', input: { topic: 'x' }, waitForResult: 'async' },
      makeCtx(),
    );

    expect(result.type).toBe('text');
    expect(received).toBeDefined();
    if (result.type === 'text' && received) {
      expect(result.text).toMatch(/async/i);
      // The returned text must surface the envelope id so callers can wire an
      // ephemeral listener with metadata.replyTo === envelope.id.
      expect(result.text).toContain(received.id);
    }
  });

  it("approvalGate mode='block' short-circuits before publishing", async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([
      makeCard('billing-agent', 'billing.refund', ['billing.refund.requested']),
    ]);
    const store = new InMemoryApprovalPolicyStore();
    const tool = createDelegateTool({
      transport,
      registry,
      approvalGate: {
        transport,
        store,
        // Gate on every delegate call — the caller's policy decides risk.
        predicate: (_toolName, input) => {
          const cap = (input as { capability?: string } | undefined)?.capability;
          if (cap === 'billing.refund') {
            return {
              approvalKey: `delegate:${cap}`,
              command: `delegate → ${cap}`,
              reason: 'risky capability',
            };
          }
          return null;
        },
        mode: 'block',
      },
    });

    const result = await tool.execute('d-block', {
      capability: 'billing.refund',
      input: { amount: 100 },
      timeoutMs: 500,
    }, makeCtx());

    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toContain("mode='block'");
  });

  it("approvalGate mode='off' lets non-risky caps through untouched", async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([makeCard('summarizer', 'summarize', ['summarize.requested'])]);
    transport.subscribe('summarize.requested', async (env) => {
      await transport.publish({
        id: messageId(), topic: 'summarize.completed', type: 'result',
        payload: { content: 'ok', toolCalls: [] },
        metadata: { ...env.metadata, replyTo: env.id, timestamp: Date.now() },
      });
    });

    const store = new InMemoryApprovalPolicyStore();
    const tool = createDelegateTool({
      transport,
      registry,
      approvalGate: {
        transport,
        store,
        predicate: (_toolName, input) => {
          const cap = (input as { capability?: string } | undefined)?.capability;
          return cap === 'billing.refund'
            ? { approvalKey: `delegate:${cap}`, command: `delegate → ${cap}`, reason: 'risky' }
            : null;
        },
        mode: 'off',
      },
    });

    const result = await tool.execute('d-off', {
      capability: 'summarize',
      input: { prompt: 'x' },
      timeoutMs: 2000,
    }, makeCtx());

    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('ok');
  });

  it('async background subagent folds its result into the live turn via steerSelf', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([]);
    const steered: string[] = [];
    const compiled = {
      type: 'compiled' as const,
      name: 'worker',
      description: 'w',
      runtime: {
        abort: () => {},
        async *execute() {
          yield { type: 'done', content: 'bg done', toolCalls: [] };
        },
      },
    };
    const tool = createDelegateTool({
      transport, registry, subagents: [compiled as never], callerAgentName: 'parent',
    });
    const ctx = { ...makeCtx(), steerSelf: (m: string) => { steered.push(m); return true; } };
    const result = await tool.execute('d-async', {
      capability: 'worker', input: 'go', waitForResult: 'async',
    }, ctx);

    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('background job');
    // allow the detached pump microtasks to flush
    await new Promise((r) => setTimeout(r, 10));
    expect(steered.some((m) => m.includes('bg done'))).toBe(true);
  });
});

function fakeRuntime(events: AgentEvent[], opts: { hang?: boolean } = {}): AgentRuntime {
  let aborted = false;
  let releaseHang: (() => void) | undefined;
  return {
    // abort() must terminate a hung run, the way a real runtime does.
    abort: () => { aborted = true; releaseHang?.(); },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent> {
      for (const e of events) {
        if (aborted) return;
        yield e;
      }
      if (opts.hang) {
        // wait until abort() releases us, then end the run (no further yields)
        await new Promise<void>((res) => { releaseHang = res; });
      }
    },
  } as unknown as AgentRuntime;
}

describe('drainRuntime', () => {
  it('returns the last done content with isError=false', async () => {
    const rt = fakeRuntime([
      { type: 'done', content: 'final answer', toolCalls: [] } as AgentEvent,
    ]);
    const out = await drainRuntime('child', rt, { prompt: 'hi' });
    expect(out).toEqual({ content: 'final answer', isError: false, timedOut: false });
  });

  it('marks isError and carries the message on an error event', async () => {
    const rt = fakeRuntime([
      { type: 'error', message: 'boom' } as AgentEvent,
    ]);
    const out = await drainRuntime('child', rt, { prompt: 'hi' });
    expect(out).toEqual({ content: 'boom', isError: true, timedOut: false });
  });

  it('relays events via onEvent', async () => {
    const seen: string[] = [];
    const rt = fakeRuntime([
      { type: 'done', content: 'x', toolCalls: [] } as AgentEvent,
    ]);
    await drainRuntime('child', rt, 'plain string', {
      onEvent: (e) => seen.push(e.type),
    });
    expect(seen).toEqual(['done']);
  });

  it('aborts and reports timedOut when timeoutMs elapses', async () => {
    const rt = fakeRuntime([], { hang: true });
    const out = await drainRuntime('slow', rt, { prompt: 'hi' }, { timeoutMs: 20 });
    expect(out.timedOut).toBe(true);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('exceeded 20ms');
  });

  it('serializes a non-string input to JSON for the prompt', async () => {
    let receivedPrompt: unknown;
    const rt = {
      abort: () => {},
      async *execute(input: AgentInput) {
        receivedPrompt = input.prompt;
        yield { type: 'done', content: 'ok', toolCalls: [] } as AgentEvent;
      },
    } as unknown as AgentRuntime;
    await drainRuntime('child', rt, { a: 1 });
    expect(receivedPrompt).toBe(JSON.stringify({ a: 1 }));
  });
});
