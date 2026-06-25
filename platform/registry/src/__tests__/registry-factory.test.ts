import { describe, it, expect, vi } from 'vitest';
import { topic, type AgentCard } from '@dongkseo/contracts';
import { createAgentRegistry } from '../factory.js';
import { FakeRedis } from './fake-redis.js';

// ioredis is an OPTIONAL peer dep. The "not installed" test must simulate its
// absence deterministically — relying on the real environment is flaky (ioredis
// is resolvable in this workspace). Make the lazy `import('ioredis')` reject so
// the factory's loadIoredis() catch fires. Tests that inject a Redis client
// never import ioredis, so this mock does not affect them.
vi.mock('ioredis', () => {
  throw new Error("Cannot find module 'ioredis'");
});

function card(name: string, overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name,
    version: '0.1.0',
    description: name,
    capabilities: [],
    subscribes: [],
    publishes: [],
    tools: [],
    architecture: 'react',
    ...overrides,
  };
}

describe('createAgentRegistry', () => {
  it('defaults to an in-memory registry when no kind is given', async () => {
    const created = await createAgentRegistry();
    expect(created.description.kind).toBe('memory');
    expect(created.description.distributed).toBe(false);

    await created.registry.register(card('a'));
    expect(await created.registry.get('a')).not.toBeNull();
    await created.close();
  });

  it('builds an in-memory registry for kind=memory', async () => {
    const created = await createAgentRegistry({ kind: 'memory' });
    expect(created.description.kind).toBe('memory');
    await created.close();
  });

  it('requires redisUrl or redisClient for kind=redis', async () => {
    await expect(createAgentRegistry({ kind: 'redis' })).rejects.toThrow(/requires a Redis URL/);
  });

  it('reports a clear error when ioredis is not installed', async () => {
    await expect(
      createAgentRegistry({ kind: 'redis', redisUrl: 'redis://localhost:6379' }),
    ).rejects.toThrow(/ioredis.*not installed/);
  });

  it('uses an injected redisClient without touching ioredis', async () => {
    const redis = new FakeRedis();
    const created = await createAgentRegistry({ kind: 'redis', redisClient: redis, ttlMs: 30_000 });
    expect(created.description.kind).toBe('redis');
    expect(created.description.distributed).toBe(true);
    expect(created.description.ttlMs).toBe(30_000);

    await created.registry.register(card('a', { capabilities: ['x'] }));
    expect((await created.registry.findByCapability('x')).map((c) => c.name)).toEqual(['a']);

    // Factory does not own an injected client → close() must not quit it.
    await created.close();
    expect(redis.quitCalls).toBe(0);
  });
});
