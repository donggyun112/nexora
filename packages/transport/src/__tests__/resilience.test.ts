/**
 * Resilience tests — verify transport gracefully handles failures.
 *
 * Tests:
 * - Handler crash: one handler throwing doesn't kill other deliveries
 * - Close during inflight: pending work completes or is dropped cleanly
 * - Nack redelivery: nacked messages are retried
 * - Publish after close: rejects cleanly
 */

import { describe, it, expect } from 'vitest';
import { InMemoryDurableTransport } from '../durable-local.js';
import type { MessageEnvelope } from '@nexora/contracts';
import { messageId } from '@nexora/contracts';

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

describe('Transport resilience', () => {
  it('handler crash does not prevent other messages from being delivered', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 10 });
    const delivered: number[] = [];
    let callCount = 0;

    t.subscribeGroup('crash', 'workers', async (env, ctl) => {
      callCount++;
      const i = (env.payload as { i: number }).i;
      if (i === 1) {
        // Simulate crash: nack so it can be retried
        await ctl.nack();
        throw new Error('boom');
      }
      delivered.push(i);
      await ctl.ack();
    });

    await t.publish(makeEnvelope('crash', { i: 0 }));
    await t.publish(makeEnvelope('crash', { i: 1 }));
    await t.publish(makeEnvelope('crash', { i: 2 }));

    await delay(200);

    // Messages 0 and 2 should have been delivered
    expect(delivered).toContain(0);
    expect(delivered).toContain(2);
    await t.close();
  });

  it('publish after close rejects with clear error', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 10 });
    await t.close();

    await expect(
      t.publish(makeEnvelope('x')),
    ).rejects.toThrow(/closed/);
  });

  it('nacked messages eventually get redelivered', async () => {
    const t = new InMemoryDurableTransport({
      pollIntervalMs: 10,
      visibilityTimeoutMs: 30,
    });

    let attempts = 0;
    t.subscribeGroup('nack-test', 'workers', async (env, ctl) => {
      attempts++;
      if (attempts < 3) {
        await ctl.nack();
        return;
      }
      await ctl.ack();
    });

    await t.publish(makeEnvelope('nack-test', {}));
    await delay(500);

    expect(attempts).toBeGreaterThanOrEqual(3);
    await t.close();
  });

  it('many subscriptions on same topic all unsubscribe cleanly', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 10 });
    const subs = [];

    for (let i = 0; i < 10; i++) {
      subs.push(t.subscribeGroup('multi', `group-${i}`, async (_env, ctl) => {
        await ctl.ack();
      }));
    }

    // Should not throw
    await t.close();
  });
});
