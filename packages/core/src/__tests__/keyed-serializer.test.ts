import { describe, it, expect } from 'vitest';

import { KeyedSerializer } from '../keyed-serializer.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('KeyedSerializer.runExclusive', () => {
  it('returns the value produced by the critical section', async () => {
    const ks = new KeyedSerializer();
    const result = await ks.runExclusive('k', async () => 42);
    expect(result).toBe(42);
  });

  it('serializes same-key read-modify-write so no update is lost', async () => {
    const ks = new KeyedSerializer();
    const shared = { value: 0 };

    // Each section reads, yields (inviting interleaving), then writes read+1.
    // Without serialization both read 0 and both write 1 → final 1 (lost update).
    // With it they run one-at-a-time → final 2.
    const rmw = () =>
      ks.runExclusive('file.txt', async () => {
        const v = shared.value;
        await tick();
        shared.value = v + 1;
      });

    await Promise.all([rmw(), rmw()]);

    expect(shared.value).toBe(2);
  });

  it('lets different keys run concurrently', async () => {
    const ks = new KeyedSerializer();
    const order: string[] = [];

    const a = ks.runExclusive('a', async () => {
      order.push('a-start');
      await tick();
      order.push('a-end');
    });
    const b = ks.runExclusive('b', async () => {
      order.push('b-start');
      await tick();
      order.push('b-end');
    });

    await Promise.all([a, b]);

    // Disjoint keys overlap: both critical sections start before either ends.
    expect(order.slice(0, 2).sort()).toEqual(['a-start', 'b-start']);
  });

  it('releases the lock when the critical section throws', async () => {
    const ks = new KeyedSerializer();

    await expect(
      ks.runExclusive('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // A subsequent section on the same key must still acquire the lock.
    const result = await ks.runExclusive('k', async () => 'recovered');
    expect(result).toBe('recovered');
  });
});
