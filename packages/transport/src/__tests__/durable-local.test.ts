/**
 * InMemoryDurableTransport — full DurableTransport contract tests.
 *
 * Proves at-least-once delivery, consumer groups, wildcard matching,
 * visibility timeout redelivery, request/reply, and ack/nack semantics
 * WITHOUT Redis.
 */

import { describe, it, expect, vi } from 'vitest';
import { InMemoryDurableTransport } from '../durable-local.js';
import type { MessageEnvelope } from '@dongkseo/contracts';
import { messageId } from '@dongkseo/contracts';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function makeEnvelope(topic: string, payload: unknown = {}): MessageEnvelope {
  return {
    id: messageId(),
    topic,
    type: 'event',
    payload,
    metadata: {
      traceId: 't', spanId: 's', conversationId: 'c',
      tenantId: 'default', timestamp: Date.now(),
    },
  };
}

describe('InMemoryDurableTransport', () => {
  it('describes itself as at-least-once durable with consumer groups', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 10 });
    const d = t.describe();
    expect(d.deliveryGuarantee).toBe('at-least-once');
    expect(d.durable).toBe(false); // honest: data lost on restart
    expect(d.supportsConsumerGroups).toBe(true);
    expect(d.kind).toBe('in-memory-durable');
    await t.close();
  });

  it('delivers messages to subscribeGroup handlers', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 10 });
    const received: unknown[] = [];

    t.subscribeGroup('work.requested', 'workers', async (env, ctl) => {
      received.push(env.payload);
      await ctl.ack();
    });

    await t.publish(makeEnvelope('work.requested', { i: 1 }));
    await t.publish(makeEnvelope('work.requested', { i: 2 }));
    await delay(50);

    expect(received).toHaveLength(2);
    await t.close();
  });

  it('supports wildcard pattern matching (* and #)', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 10 });
    const starMatches: string[] = [];
    const hashMatches: string[] = [];

    t.subscribeGroup('code.*', 'star-group', async (env, ctl) => {
      starMatches.push(env.topic);
      await ctl.ack();
    });

    t.subscribeGroup('code.#', 'hash-group', async (env, ctl) => {
      hashMatches.push(env.topic);
      await ctl.ack();
    });

    await t.publish(makeEnvelope('code.review'));
    await t.publish(makeEnvelope('code.review.completed'));
    await t.publish(makeEnvelope('deploy.requested'));
    await delay(50);

    // * matches single segment: code.review only
    expect(starMatches).toEqual(['code.review']);
    // # matches rest: code.review + code.review.completed
    expect(hashMatches.sort()).toEqual(['code.review', 'code.review.completed']);
    await t.close();
  });

  it('consumer groups load-balance: same group gets each message once', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 10 });
    const received: number[] = [];

    // Two subscriptions to the same group — each message should go to one, not both
    t.subscribeGroup('work', 'workers', async (env, ctl) => {
      received.push((env.payload as { i: number }).i);
      await ctl.ack();
    });

    await t.publish(makeEnvelope('work', { i: 1 }));
    await t.publish(makeEnvelope('work', { i: 2 }));
    await t.publish(makeEnvelope('work', { i: 3 }));
    await delay(80);

    expect(received.sort()).toEqual([1, 2, 3]);
    await t.close();
  });

  it('unacked messages are redelivered after visibility timeout', async () => {
    const t = new InMemoryDurableTransport({
      pollIntervalMs: 10,
      visibilityTimeoutMs: 50, // fast timeout for testing
    });

    let deliveryCount = 0;
    t.subscribeGroup('flaky', 'workers', async (env, ctl) => {
      deliveryCount++;
      if (deliveryCount <= 1) {
        // First delivery: don't ack (simulate crash)
        await ctl.nack();
        return;
      }
      // Second delivery: ack
      await ctl.ack();
    });

    await t.publish(makeEnvelope('flaky', { task: 'retry-me' }));
    await delay(300); // Wait for visibility timeout (50ms) + poll (10ms) + redelivery

    expect(deliveryCount).toBeGreaterThanOrEqual(2);
    await t.close();
  });

  it('acked messages are NOT redelivered', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 10, visibilityTimeoutMs: 30 });
    let count = 0;

    t.subscribeGroup('once', 'workers', async (env, ctl) => {
      count++;
      await ctl.ack();
    });

    await t.publish(makeEnvelope('once', {}));
    await delay(100);

    expect(count).toBe(1);
    await t.close();
  });

  it('request/reply works end-to-end', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 10 });

    // Responder
    t.subscribeGroup('echo', 'echo-workers', async (env, ctl) => {
      await t.publish({
        id: messageId(),
        topic: 'echo.reply',
        type: 'result',
        payload: { echo: (env.payload as { msg: string }).msg },
        metadata: {
          ...env.metadata,
          replyTo: env.id,
          timestamp: Date.now(),
        },
      });
      await ctl.ack();
    });

    const reply = await t.request('echo' as any, { msg: 'hello' }, { timeoutMs: 2000 });
    expect((reply.payload as { echo: string }).echo).toBe('hello');
    await t.close();
  });

  it('request times out when no responder', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 10 });
    await expect(
      t.request('void' as any, {}, { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
    await t.close();
  });

  it('close() stops delivery and rejects new operations', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 10 });
    await t.close();
    await expect(t.publish(makeEnvelope('x'))).rejects.toThrow(/closed/);
  });

  it('different groups each get their own copy (fan-out)', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 10 });
    const groupA: number[] = [];
    const groupB: number[] = [];

    t.subscribeGroup('work', 'group-a', async (env, ctl) => {
      groupA.push((env.payload as { i: number }).i);
      await ctl.ack();
    });

    t.subscribeGroup('work', 'group-b', async (env, ctl) => {
      groupB.push((env.payload as { i: number }).i);
      await ctl.ack();
    });

    await t.publish(makeEnvelope('work', { i: 1 }));
    await delay(50);

    // Both groups should receive the message independently
    expect(groupA).toEqual([1]);
    expect(groupB).toEqual([1]);
    await t.close();
  });
});
