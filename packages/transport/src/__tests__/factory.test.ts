import { describe, it, expect, vi } from 'vitest';
import { createTransport } from '../factory.js';
import type { RedisLike, RedisStreamsLike } from '../index.js';

// ioredis is an OPTIONAL peer dep. The "not installed" test must simulate its
// absence deterministically — relying on the real environment is flaky (ioredis
// is resolvable in this workspace). Make the lazy `import('ioredis')` reject so
// the factory's loadIoredis() catch fires. Tests that inject Redis clients
// never import ioredis, so this mock does not affect them.
vi.mock('ioredis', () => {
  throw new Error("Cannot find module 'ioredis'");
});

describe('createTransport', () => {
  it('defaults to LocalTransport when no kind is given', async () => {
    const created = await createTransport();
    expect(created.description.kind).toBe('local');
    expect(created.description.deliveryGuarantee).toBe('at-most-once');
    expect(created.description.durable).toBe(false);
    await created.close();
  });

  it('builds a LocalTransport for kind=local', async () => {
    const created = await createTransport({ kind: 'local' });
    expect(created.description.kind).toBe('local');
    await created.close();
  });

  it('requires redisUrl or redisClients for redis-* kinds', async () => {
    await expect(createTransport({ kind: 'redis-streams' })).rejects.toThrow(/requires a Redis URL/);
    await expect(createTransport({ kind: 'redis-pubsub' })).rejects.toThrow(/requires a Redis URL/);
  });

  it('reports a clear error when ioredis is not installed', async () => {
    // redisUrl is present, so the factory proceeds to the lazy ioredis import,
    // which fails because ioredis is an optional (uninstalled) peer dep.
    await expect(
      createTransport({ kind: 'redis-streams', redisUrl: 'redis://localhost:6379' }),
    ).rejects.toThrow(/ioredis.*not installed/);
  });

  it('uses injected redisClients without touching ioredis (redis-streams)', async () => {
    const clients = { publisher: makeFakeRedis(), consumer: makeFakeRedis() };
    const created = await createTransport({ kind: 'redis-streams', redisClients: clients });
    expect(created.description.kind).toBe('redis-streams');
    expect(created.description.durable).toBe(true);
    // Factory does not own injected clients → close() must not quit them.
    await created.close();
    expect(clients.publisher.quitCalls).toBe(0);
    expect(clients.consumer.quitCalls).toBe(0);
  });

  it('uses injected redisClients for redis-pubsub', async () => {
    const clients = { publisher: makeFakeRedis(), consumer: makeFakeRedis() };
    const created = await createTransport({ kind: 'redis-pubsub', redisClients: clients });
    expect(created.description.kind).toBe('redis-pubsub');
    await created.close();
  });
});

// Minimal fake satisfying both RedisLike (pubsub) and RedisStreamsLike (streams)
// surfaces — enough for the factory to construct a transport. We never publish,
// so the no-op command stubs are sufficient.
function makeFakeRedis(): RedisLike & RedisStreamsLike & { quitCalls: number } {
  return {
    quitCalls: 0,
    // RedisLike (pubsub)
    publish: () => 0,
    psubscribe: () => undefined,
    punsubscribe: () => undefined,
    on: () => undefined,
    // RedisStreamsLike
    xadd: async () => '0-0',
    xgroup: async () => undefined,
    xreadgroup: async () => null,
    xack: async () => 0,
    xlen: async () => 0,
    async quit(this: { quitCalls: number }) { this.quitCalls++; return 'OK'; },
  };
}
