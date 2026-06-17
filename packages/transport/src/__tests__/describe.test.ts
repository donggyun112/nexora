/**
 * Transport describe() regression — ensures the delivery-guarantee advertising
 * is honest across all transport implementations. The tests also assert that
 * at-most-once transports fail `assertDurable()` so misuse in workflow code
 * surfaces loudly.
 */

import { describe, it, expect } from 'vitest';
import { assertDurable } from '@dongkseo/contracts';
import type { RedisLike } from '../redis.js';
import { LocalTransport } from '../local.js';
import { RedisTransport } from '../redis.js';
import { TracingTransport } from '../tracing.js';

describe('Transport.describe()', () => {
  it('LocalTransport reports at-most-once, non-durable, no groups', async () => {
    const t = new LocalTransport();
    const d = t.describe();
    expect(d.kind).toBe('local');
    expect(d.deliveryGuarantee).toBe('at-most-once');
    expect(d.durable).toBe(false);
    expect(d.supportsConsumerGroups).toBe(false);
    await t.close();
  });

  it('RedisTransport reports at-most-once, non-durable, pubsub kind', () => {
    const fakeRedis: RedisLike = {
      publish: async () => 0,
      psubscribe: async () => undefined,
      punsubscribe: async () => undefined,
      on: () => undefined,
    };
    const t = new RedisTransport({
      subscriber: fakeRedis,
      publisher: fakeRedis,
      channelPrefix: 'test',
    });
    const d = t.describe();
    expect(d.kind).toBe('redis-pubsub');
    expect(d.deliveryGuarantee).toBe('at-most-once');
    expect(d.durable).toBe(false);
    expect(d.supportsConsumerGroups).toBe(false);
    expect(d.notes).toContain('test');
  });

  it('TracingTransport forwards the inner description and annotates', async () => {
    const inner = new LocalTransport();
    const wrapped = new TracingTransport(inner);
    const d = wrapped.describe();
    expect(d.kind).toBe('local'); // preserves inner kind
    expect(d.deliveryGuarantee).toBe('at-most-once'); // wrapping doesn't upgrade
    expect(d.notes).toContain('TracingTransport');
    await wrapped.close();
  });
});

describe('assertDurable', () => {
  it('throws when LocalTransport is passed where DurableTransport is expected', async () => {
    const t = new LocalTransport();
    expect(() => assertDurable(t)).toThrow(/requires a DurableTransport/);
    await t.close();
  });

  it('throws with a helpful message pointing at the transport kind', async () => {
    const t = new LocalTransport();
    try {
      assertDurable(t);
      expect.fail('assertDurable should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('local');
      expect((err as Error).message).toContain('at-most-once');
    }
    await t.close();
  });
});
