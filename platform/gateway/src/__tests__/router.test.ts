import { describe, it, expect, vi } from 'vitest';
import { GatewayRouter, LocalRuntimeRouter } from '../router.js';
import type {
  Transport,
  Subscription,
  RequestOptions,
  TopicString,
  MessageEnvelope,
  AgentRuntime,
  AgentInput,
  AgentEvent,
} from '@nexora/contracts';
import { messageId } from '@nexora/contracts';

class FakeTransport implements Transport {
  public requests: { topic: string; payload: unknown; options?: RequestOptions }[] = [];

  constructor(private readonly replyFn: (topic: string, payload: unknown) => unknown) {}

  async publish(): Promise<void> {}
  subscribe(): Subscription { return { unsubscribe: () => {} }; }
  async request(topic: TopicString, payload: unknown, options?: RequestOptions): Promise<MessageEnvelope> {
    this.requests.push({ topic: String(topic), payload, options });
    return {
      id: messageId(),
      topic: String(topic),
      type: 'result',
      payload: this.replyFn(String(topic), payload),
      metadata: {
        traceId: options?.traceId ?? 't',
        spanId: 's',
        conversationId: options?.conversationId ?? 'c',
        tenantId: options?.tenantId ?? 'default',
        timestamp: Date.now(),
      },
    };
  }
  async close(): Promise<void> {}
}

describe('GatewayRouter', () => {
  it('routes to default topic when no resolver', async () => {
    const transport = new FakeTransport(() => ({ content: 'result text' }));
    const router = new GatewayRouter({
      transport,
      defaultTopic: 'chat.requested' as TopicString,
    });

    const out = await router.route({
      platform: 'http',
      channelId: 'ch',
      userId: 'u',
      displayName: 'd',
      content: 'hello',
      tenantId: 'tenant-A',
    });

    expect(out.content).toBe('result text');
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].topic).toBe('chat.requested');
    expect((transport.requests[0].payload as { prompt: string }).prompt).toBe('hello');
    expect(transport.requests[0].options?.tenantId).toBe('tenant-A');
  });

  it('uses intent resolver when provided', async () => {
    const transport = new FakeTransport((topic) => ({ content: `from ${topic}` }));
    const resolver = vi.fn(async (msg) => {
      if (msg.content.includes('deploy')) return 'deploy.requested' as TopicString;
      return 'chat.requested' as TopicString;
    });
    const router = new GatewayRouter({
      transport,
      defaultTopic: 'chat.requested' as TopicString,
      intentResolver: { resolve: resolver },
    });

    const out = await router.route({
      platform: 'http',
      channelId: 'ch',
      userId: 'u',
      displayName: 'd',
      content: 'please deploy',
      tenantId: 'default',
    });
    expect(out.content).toBe('from deploy.requested');
    expect(resolver).toHaveBeenCalled();
  });

  it('formats error payloads', async () => {
    const transport = new FakeTransport(() => ({ error: 'something broke' }));
    const router = new GatewayRouter({
      transport,
      defaultTopic: 'x' as TopicString,
    });
    const out = await router.route({
      platform: 'http',
      channelId: 'ch',
      userId: 'u',
      displayName: 'd',
      content: 'x',
      tenantId: 'default',
    });
    expect(out.content).toContain('[ERROR]');
    expect(out.content).toContain('something broke');
  });
});

describe('LocalRuntimeRouter', () => {
  function makeRuntime(events: AgentEvent[]): AgentRuntime {
    return {
      async *execute(_input: AgentInput) {
        for (const e of events) yield e;
      },
      abort: () => {},
    };
  }

  it('drains events and returns last done content', async () => {
    const router = new LocalRuntimeRouter({
      createRuntime: () => makeRuntime([
        { type: 'text', text: 'hi' },
        { type: 'done', content: 'final', toolCalls: [] },
      ]),
    });
    const out = await router.route({
      platform: 'http',
      channelId: 'ch',
      userId: 'u',
      displayName: 'd',
      content: 'q',
      tenantId: 'default',
    });
    expect(out.content).toBe('final');
  });

  it('streams events as outbound chunks', async () => {
    const router = new LocalRuntimeRouter({
      createRuntime: () => makeRuntime([
        { type: 'text', text: 'A' },
        { type: 'tool_call', id: 't', name: 'echo', input: {} },
        { type: 'tool_result', id: 't', name: 'echo', result: { type: 'text', text: 'ok' }, isError: false },
        { type: 'done', content: 'final', toolCalls: [] },
      ]),
    });

    const chunks: unknown[] = [];
    await router.routeStream({
      platform: 'http',
      channelId: 'ch',
      userId: 'u',
      displayName: 'd',
      content: 'q',
      tenantId: 'default',
    }, (c) => chunks.push(c));

    const types = (chunks as { type: string }[]).map(c => c.type);
    expect(types).toEqual(['text', 'tool_call', 'tool_result', 'done']);
  });
});
