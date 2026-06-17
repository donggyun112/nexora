import { describe, it, expect, vi } from 'vitest';
import { DLQTransport } from '../dlq.js';
import { LocalTransport, createEnvelope } from '../local.js';
import type { MessageEnvelope } from '@dongkseo/contracts';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('DLQTransport', () => {
  it('routes failed handler messages to dlq.{topic}', async () => {
    const inner = new LocalTransport();
    const dlq = new DLQTransport({ inner, idempotencyWindowMs: 0 });

    const dlqMessages: MessageEnvelope[] = [];
    dlq.subscribe('dlq.#', async (env) => { dlqMessages.push(env); });
    dlq.subscribe('work.requested', async () => { throw new Error('handler boom'); });

    await dlq.publish(createEnvelope({ topic: 'work.requested', payload: { task: 'A' } }));
    await delay(30);

    expect(dlqMessages).toHaveLength(1);
    const payload = dlqMessages[0].payload as { originalEnvelope: MessageEnvelope; error: string };
    expect(payload.error).toContain('handler boom');
    expect((payload.originalEnvelope.payload as { task: string }).task).toBe('A');
    expect(dlqMessages[0].topic).toBe('dlq.work.requested');

    await dlq.close();
  });

  it('successful messages are NOT routed to DLQ', async () => {
    const inner = new LocalTransport();
    const dlq = new DLQTransport({ inner, idempotencyWindowMs: 0 });

    const dlqMessages: MessageEnvelope[] = [];
    dlq.subscribe('dlq.#', async (env) => { dlqMessages.push(env); });
    dlq.subscribe('work.requested', async () => { /* success */ });

    await dlq.publish(createEnvelope({ topic: 'work.requested', payload: {} }));
    await delay(30);

    expect(dlqMessages).toHaveLength(0);
    await dlq.close();
  });

  it('idempotency: duplicate messages are skipped', async () => {
    const inner = new LocalTransport();
    const dlq = new DLQTransport({ inner, idempotencyWindowMs: 60_000 });

    let callCount = 0;
    dlq.subscribe('work.requested', async () => { callCount++; });

    const envelope = createEnvelope({ topic: 'work.requested', payload: {} });

    await dlq.publish(envelope);
    await delay(20);
    expect(callCount).toBe(1);

    // Same envelope again
    await dlq.publish(envelope);
    await delay(20);
    expect(callCount).toBe(1); // NOT incremented

    expect(dlq.seenSize()).toBe(1);
    await dlq.close();
  });

  it('idempotency disabled when windowMs=0', async () => {
    const inner = new LocalTransport();
    const dlq = new DLQTransport({ inner, idempotencyWindowMs: 0 });

    let callCount = 0;
    dlq.subscribe('work.requested', async () => { callCount++; });

    const envelope = createEnvelope({ topic: 'work.requested', payload: {} });

    await dlq.publish(envelope);
    await delay(20);
    await dlq.publish(envelope);
    await delay(20);

    expect(callCount).toBe(2); // both processed
    expect(dlq.seenSize()).toBe(0);
    await dlq.close();
  });

  it('describe() annotates inner transport description', async () => {
    const inner = new LocalTransport();
    const dlq = new DLQTransport({ inner });
    const desc = dlq.describe();
    expect(desc.kind).toBe('local');
    expect(desc.notes).toContain('DLQ');
    expect(desc.notes).toContain('idempotency');
    await dlq.close();
  });

  it('failed DLQ messages are marked seen to prevent retry loops', async () => {
    const inner = new LocalTransport();
    const dlq = new DLQTransport({ inner, idempotencyWindowMs: 60_000 });

    let callCount = 0;
    dlq.subscribe('work.requested', async () => {
      callCount++;
      throw new Error('always fails');
    });

    const envelope = createEnvelope({ topic: 'work.requested', payload: {} });
    await dlq.publish(envelope);
    await delay(20);
    expect(callCount).toBe(1);

    // Re-deliver same envelope (simulating durable transport redeliver)
    await dlq.publish(envelope);
    await delay(20);
    expect(callCount).toBe(1); // NOT retried — already in seen-set

    await dlq.close();
  });
});
