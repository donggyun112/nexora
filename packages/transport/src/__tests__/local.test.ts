import { describe, it, expect, vi } from 'vitest';
import { LocalTransport, createEnvelope } from '../local.js';
import type { MessageEnvelope } from '@nexora/contracts';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('LocalTransport publish/subscribe', () => {
  it('delivers message to exact-match subscriber', async () => {
    const t = new LocalTransport();
    const handler = vi.fn();
    t.subscribe('code.review.requested', async (env) => { handler(env); });

    await t.publish(createEnvelope({
      topic: 'code.review.requested',
      payload: { pr: 123 },
    }));

    await delay(20);
    expect(handler).toHaveBeenCalledTimes(1);
    const arg = handler.mock.calls[0][0] as MessageEnvelope;
    expect(arg.payload).toEqual({ pr: 123 });
    await t.close();
  });

  it('matches wildcard patterns', async () => {
    const t = new LocalTransport();
    const handlerStar = vi.fn();
    const handlerHash = vi.fn();
    t.subscribe('code.*.requested', async (e) => { handlerStar(e); });
    t.subscribe('code.#', async (e) => { handlerHash(e); });

    await t.publish(createEnvelope({ topic: 'code.review.requested', payload: 1 }));
    await t.publish(createEnvelope({ topic: 'code.fix.completed', payload: 2 }));

    await delay(20);
    expect(handlerStar).toHaveBeenCalledTimes(1); // only review.requested
    expect(handlerHash).toHaveBeenCalledTimes(2);  // both
    await t.close();
  });

  it('does not deliver to unmatched subscribers', async () => {
    const t = new LocalTransport();
    const handler = vi.fn();
    t.subscribe('deploy.requested', async (e) => { handler(e); });
    await t.publish(createEnvelope({ topic: 'code.review.requested', payload: 1 }));
    await delay(20);
    expect(handler).not.toHaveBeenCalled();
    await t.close();
  });

  it('unsubscribe stops delivery', async () => {
    const t = new LocalTransport();
    const handler = vi.fn();
    const sub = t.subscribe('test', async (e) => { handler(e); });
    sub.unsubscribe();
    await t.publish(createEnvelope({ topic: 'test', payload: 1 }));
    await delay(20);
    expect(handler).not.toHaveBeenCalled();
    expect(t.subscriberCount()).toBe(0);
    await t.close();
  });

  it('isolates handler errors', async () => {
    const onError = vi.fn();
    const t = new LocalTransport({ onHandlerError: onError });
    const goodHandler = vi.fn();
    t.subscribe('test', async () => { throw new Error('boom'); });
    t.subscribe('test', async (e) => { goodHandler(e); });

    await t.publish(createEnvelope({ topic: 'test', payload: 1 }));
    await delay(20);
    expect(onError).toHaveBeenCalled();
    expect(goodHandler).toHaveBeenCalled();
    await t.close();
  });
});

describe('LocalTransport request/reply', () => {
  it('matches reply by metadata.replyTo', async () => {
    const t = new LocalTransport();

    // Worker that replies to incoming requests
    t.subscribe('compute.add', async (env) => {
      const { a, b } = env.payload as { a: number; b: number };
      await t.publish({
        id: 'reply-' + env.id,
        topic: 'compute.add.result',
        type: 'result',
        payload: { sum: a + b },
        metadata: {
          ...env.metadata,
          replyTo: env.id,
          spanId: 'worker-span',
          parentSpanId: env.metadata.spanId,
          timestamp: Date.now(),
        },
      });
    });

    const reply = await t.request('compute.add' as never, { a: 2, b: 3 }, { timeoutMs: 1000 });
    expect(reply.payload).toEqual({ sum: 5 });
    await t.close();
  });

  it('rejects on timeout', async () => {
    const t = new LocalTransport();
    await expect(
      t.request('void' as never, {}, { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
    await t.close();
  });
});

describe('LocalTransport close()', () => {
  it('rejects publish/subscribe after close', async () => {
    const t = new LocalTransport();
    await t.close();
    await expect(t.publish(createEnvelope({ topic: 'x', payload: 1 }))).rejects.toThrow(/closed/);
    expect(() => t.subscribe('x', async () => {})).toThrow(/closed/);
  });
});
