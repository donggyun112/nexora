/**
 * Load test — verify transport handles high-throughput message bursts.
 *
 * Tests:
 * - Burst delivery: 1000 messages delivered without loss
 * - Concurrent publishers: multiple publishers don't corrupt state
 * - Wildcard fan-out under load: n groups × m messages = correct totals
 */

import { describe, it, expect } from 'vitest';
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

describe('Transport load tests', () => {
  it('delivers 1000 messages without loss', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 5 });
    let received = 0;

    t.subscribeGroup('load.test', 'workers', async (_env, ctl) => {
      received++;
      await ctl.ack();
    });

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 1000; i++) {
      promises.push(t.publish(makeEnvelope('load.test', { i })));
    }
    await Promise.all(promises);

    // Wait for all deliveries (poll-based, may need time)
    const deadline = Date.now() + 5000;
    while (received < 1000 && Date.now() < deadline) {
      await delay(20);
    }

    expect(received).toBe(1000);
    await t.close();
  });

  it('concurrent publishers do not corrupt state', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 5 });
    const received = new Set<number>();

    t.subscribeGroup('concurrent', 'workers', async (env, ctl) => {
      received.add((env.payload as { i: number }).i);
      await ctl.ack();
    });

    // 10 concurrent publishers, each sending 100 messages
    const publishers = Array.from({ length: 10 }, (_, pub) =>
      Promise.all(
        Array.from({ length: 100 }, (_, msg) =>
          t.publish(makeEnvelope('concurrent', { i: pub * 100 + msg })),
        ),
      ),
    );
    await Promise.all(publishers);

    const deadline = Date.now() + 5000;
    while (received.size < 1000 && Date.now() < deadline) {
      await delay(20);
    }

    expect(received.size).toBe(1000);
    await t.close();
  });

  it('fan-out under load: 3 groups each receive all messages', async () => {
    const t = new InMemoryDurableTransport({ pollIntervalMs: 5 });
    const counts = { a: 0, b: 0, c: 0 };

    t.subscribeGroup('fanout', 'group-a', async (_env, ctl) => {
      counts.a++;
      await ctl.ack();
    });
    t.subscribeGroup('fanout', 'group-b', async (_env, ctl) => {
      counts.b++;
      await ctl.ack();
    });
    t.subscribeGroup('fanout', 'group-c', async (_env, ctl) => {
      counts.c++;
      await ctl.ack();
    });

    const N = 200;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        t.publish(makeEnvelope('fanout', { i })),
      ),
    );

    const deadline = Date.now() + 5000;
    while ((counts.a < N || counts.b < N || counts.c < N) && Date.now() < deadline) {
      await delay(20);
    }

    expect(counts.a).toBe(N);
    expect(counts.b).toBe(N);
    expect(counts.c).toBe(N);
    await t.close();
  });
});
