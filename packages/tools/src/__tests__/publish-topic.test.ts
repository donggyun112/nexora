import { describe, it, expect } from 'vitest';
import { createPublishTopicTool } from '../builtin/publish-topic.js';
import type {
  EventTransport,
  MessageEnvelope,
  RequestOptions,
  Subscription,
  TopicString,
  TransportDescription,
  ToolContext,
} from '@nexora/contracts';
import { matchTopic } from '@nexora/contracts';

class FakeTransport implements EventTransport {
  readonly published: MessageEnvelope[] = [];
  private readonly subs = new Map<
    number,
    { pattern: string; handler: (e: MessageEnvelope) => Promise<void> }
  >();
  private nextId = 0;

  describe(): TransportDescription {
    return {
      kind: 'fake',
      deliveryGuarantee: 'at-most-once',
      durable: false,
      supportsConsumerGroups: false,
    };
  }

  async publish(envelope: MessageEnvelope): Promise<void> {
    this.published.push(envelope);
    const matched = Array.from(this.subs.values()).filter((s) =>
      matchTopic(s.pattern, envelope.topic as TopicString),
    );
    for (const m of matched) await m.handler(envelope);
  }

  subscribe(
    pattern: string,
    handler: (e: MessageEnvelope) => Promise<void>,
  ): Subscription {
    const id = this.nextId++;
    this.subs.set(id, { pattern, handler });
    return {
      unsubscribe: () => {
        this.subs.delete(id);
      },
    };
  }

  async request(
    _topic: TopicString,
    _payload: unknown,
    _options?: RequestOptions,
  ): Promise<MessageEnvelope> {
    throw new Error('not used');
  }

  async close(): Promise<void> {
    this.subs.clear();
  }
}

function makeCtx(): ToolContext {
  return {
    tenantId: 'tenant-A',
    workdir: '/tmp',
    secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe('publish_topic tool', () => {
  it('publishes an envelope to the given topic with caller as sourceInstanceId', async () => {
    const transport = new FakeTransport();
    const tool = createPublishTopicTool({
      transport,
      callerAgentName: 'caller-A',
    });

    const result = await tool.execute(
      'call-1',
      { topic: 'deploy.completed', payload: { build: 42 } },
      makeCtx(),
    );

    expect(result.type).toBe('text');
    expect(transport.published).toHaveLength(1);
    const env = transport.published[0];
    expect(env.topic).toBe('deploy.completed');
    expect(env.type).toBe('event');
    expect(env.payload).toEqual({ build: 42 });
    expect(env.metadata.sourceInstanceId).toBe('caller-A');
    expect(env.metadata.tenantId).toBe('tenant-A');
  });

  it('errors when topic is missing', async () => {
    const transport = new FakeTransport();
    const tool = createPublishTopicTool({
      transport,
      callerAgentName: 'caller-A',
    });

    const result = await tool.execute('call-2', { payload: 'x' }, makeCtx());
    expect(result.type).toBe('error');
    expect(transport.published).toHaveLength(0);
  });

  it('allows publishing when topic matches the whitelist', async () => {
    const transport = new FakeTransport();
    const tool = createPublishTopicTool({
      transport,
      callerAgentName: 'caller-A',
      topicWhitelist: ['deploy.*', 'report.#'],
    });

    const ok1 = await tool.execute(
      'c1',
      { topic: 'deploy.completed' },
      makeCtx(),
    );
    const ok2 = await tool.execute(
      'c2',
      { topic: 'report.daily.generated' },
      makeCtx(),
    );

    expect(ok1.type).toBe('text');
    expect(ok2.type).toBe('text');
    expect(transport.published).toHaveLength(2);
  });

  it('rejects topics outside the whitelist', async () => {
    const transport = new FakeTransport();
    const tool = createPublishTopicTool({
      transport,
      callerAgentName: 'caller-A',
      topicWhitelist: ['deploy.*'],
    });

    const result = await tool.execute(
      'c3',
      { topic: 'billing.charged' },
      makeCtx(),
    );

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.message).toMatch(/whitelist/);
    }
    expect(transport.published).toHaveLength(0);
  });

  it('delivers payload to matching subscribers', async () => {
    const transport = new FakeTransport();
    const tool = createPublishTopicTool({
      transport,
      callerAgentName: 'caller-A',
    });

    const received: MessageEnvelope[] = [];
    transport.subscribe('user.*', async (env) => {
      received.push(env);
    });

    await tool.execute(
      'c4',
      { topic: 'user.signed_up', payload: { id: 'u-1' } },
      makeCtx(),
    );

    expect(received).toHaveLength(1);
    expect(received[0].topic).toBe('user.signed_up');
    expect(received[0].payload).toEqual({ id: 'u-1' });
  });
});
