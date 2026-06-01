import { describe, it, expect, vi } from 'vitest';
import { createEphemeralResultListener } from '../builtin/ephemeral-result-listener.js';
import type {
  EventTransport,
  MessageEnvelope,
  RequestOptions,
  Subscription,
  TopicString,
  TransportDescription,
} from '@nexora/contracts';
import { matchTopic, messageId } from '@nexora/contracts';

class FakeTransport implements EventTransport {
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

  subscriberCount(): number {
    return this.subs.size;
  }
}

function makeResultEnvelope(replyTo: string, topic: string): MessageEnvelope {
  return {
    id: messageId(),
    topic,
    type: 'result',
    payload: { value: 'ok' },
    metadata: {
      traceId: 't',
      spanId: 's',
      conversationId: 'c',
      tenantId: 'tenant-A',
      replyTo,
      timestamp: Date.now(),
    },
  };
}

describe('createEphemeralResultListener', () => {
  it('invokes onResult once when an envelope with matching replyTo arrives', async () => {
    const transport = new FakeTransport();
    const onResult = vi.fn();

    createEphemeralResultListener({
      transport,
      topicPattern: 'seo-content.#',
      correlationId: 'req-1',
      onResult,
    });

    await transport.publish(
      makeResultEnvelope('req-1', 'seo-content.completed'),
    );

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].metadata.replyTo).toBe('req-1');
  });

  it('auto-unsubscribes after the first match', async () => {
    const transport = new FakeTransport();
    const onResult = vi.fn();

    createEphemeralResultListener({
      transport,
      topicPattern: '#',
      correlationId: 'req-2',
      onResult,
    });
    expect(transport.subscriberCount()).toBe(1);

    await transport.publish(makeResultEnvelope('req-2', 'x.completed'));
    expect(transport.subscriberCount()).toBe(0);

    // Subsequent envelopes don't fire the callback again.
    await transport.publish(makeResultEnvelope('req-2', 'x.completed'));
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('ignores envelopes whose replyTo does not match', async () => {
    const transport = new FakeTransport();
    const onResult = vi.fn();

    createEphemeralResultListener({
      transport,
      topicPattern: '#',
      correlationId: 'req-A',
      onResult,
    });

    await transport.publish(makeResultEnvelope('other-id', 'x.completed'));
    expect(onResult).not.toHaveBeenCalled();
    expect(transport.subscriberCount()).toBe(1);
  });

  it('calls onTimeout and unsubscribes when no match arrives in time', async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const onResult = vi.fn();
    const onTimeout = vi.fn();

    createEphemeralResultListener({
      transport,
      topicPattern: '#',
      correlationId: 'req-T',
      onResult,
      onTimeout,
      timeoutMs: 1_000,
    });

    vi.advanceTimersByTime(1_000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
    expect(transport.subscriberCount()).toBe(0);
    vi.useRealTimers();
  });

  it('dispose() cancels the listener without firing onResult or onTimeout', async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const onResult = vi.fn();
    const onTimeout = vi.fn();

    const { dispose } = createEphemeralResultListener({
      transport,
      topicPattern: '#',
      correlationId: 'req-D',
      onResult,
      onTimeout,
      timeoutMs: 1_000,
    });

    dispose();
    expect(transport.subscriberCount()).toBe(0);

    vi.advanceTimersByTime(2_000);
    await transport.publish(makeResultEnvelope('req-D', 'x.completed'));

    expect(onResult).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
