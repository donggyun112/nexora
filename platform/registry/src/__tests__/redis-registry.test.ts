import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { topic, type AgentCard } from '@dongkseo/contracts';
import { RedisAgentRegistry } from '../redis.js';
import { FakeRedis } from './fake-redis.js';

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

const PREFIX = 'nexora';
const key = (name: string) => `${PREFIX}:registry:agent:${name}`;

describe('RedisAgentRegistry — basic CRUD (read-through)', () => {
  it('registers and round-trips a card through JSON', async () => {
    const redis = new FakeRedis();
    const reg = new RedisAgentRegistry({ client: redis, prefix: PREFIX });

    await reg.register(card('reviewer', { capabilities: ['code-review'] }));

    const got = await reg.get('reviewer');
    expect(got).not.toBeNull();
    expect(got?.name).toBe('reviewer');
    expect(got?.capabilities).toEqual(['code-review']);

    await reg.close();
  });

  it('returns null for an unknown agent', async () => {
    const reg = new RedisAgentRegistry({ client: new FakeRedis(), prefix: PREFIX });
    expect(await reg.get('missing')).toBeNull();
    await reg.close();
  });

  it('lists all registered cards', async () => {
    const reg = new RedisAgentRegistry({ client: new FakeRedis(), prefix: PREFIX });
    await reg.register(card('a'));
    await reg.register(card('b'));
    const names = (await reg.list()).map((c) => c.name).sort();
    expect(names).toEqual(['a', 'b']);
    await reg.close();
  });

  it('finds by capability', async () => {
    const reg = new RedisAgentRegistry({ client: new FakeRedis(), prefix: PREFIX });
    await reg.register(card('reviewer', { capabilities: ['code-review', 'testing'] }));
    await reg.register(card('deployer', { capabilities: ['deploy'] }));
    const found = await reg.findByCapability('code-review');
    expect(found.map((c) => c.name)).toEqual(['reviewer']);
    await reg.close();
  });

  it('finds by subscription honoring wildcard patterns', async () => {
    const reg = new RedisAgentRegistry({ client: new FakeRedis(), prefix: PREFIX });
    await reg.register(card('reviewer', { subscribes: [topic('code.review.*')] }));
    await reg.register(card('any', { subscribes: [topic('code.#')] }));
    await reg.register(card('other', { subscribes: [topic('deploy.requested')] }));

    const names = (await reg.findBySubscription('code.review.requested')).map((c) => c.name).sort();
    expect(names).toEqual(['any', 'reviewer']);
    await reg.close();
  });

  it('unregister removes the card', async () => {
    const reg = new RedisAgentRegistry({ client: new FakeRedis(), prefix: PREFIX });
    await reg.register(card('a'));
    await reg.unregister('a');
    expect(await reg.get('a')).toBeNull();
    await reg.close();
  });
});

describe('RedisAgentRegistry — TTL + heartbeat liveness', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes each card with the configured TTL', async () => {
    const redis = new FakeRedis();
    const reg = new RedisAgentRegistry({ client: redis, prefix: PREFIX, ttlMs: 30_000 });
    await reg.register(card('a'));
    // PTTL should be close to the configured TTL right after register.
    expect(redis.pttl(key('a'))).toBeGreaterThan(25_000);
    expect(redis.pttl(key('a'))).toBeLessThanOrEqual(30_000);
    await reg.close();
  });

  it('heartbeat keeps an owned card alive past its TTL', async () => {
    const redis = new FakeRedis();
    const reg = new RedisAgentRegistry({
      client: redis,
      prefix: PREFIX,
      ttlMs: 30_000,
      heartbeatMs: 10_000,
    });
    await reg.register(card('a'));

    // Advance well past one TTL while heartbeats fire every 10s.
    await vi.advanceTimersByTimeAsync(50_000);

    expect(await reg.get('a')).not.toBeNull();
    await reg.close();
  });

  it('re-registers an owned card if its key was evicted (self-heal)', async () => {
    const redis = new FakeRedis();
    const reg = new RedisAgentRegistry({
      client: redis,
      prefix: PREFIX,
      ttlMs: 30_000,
      heartbeatMs: 10_000,
    });
    await reg.register(card('a'));

    // Simulate a Redis blip: the key vanishes out from under us.
    await redis.del(key('a'));
    expect(await reg.get('a')).toBeNull();

    // One heartbeat later, the card is restored from the owned snapshot.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await reg.get('a')).not.toBeNull();
    await reg.close();
  });

  it('never refreshes a card owned by another process (lets it expire)', async () => {
    const redis = new FakeRedis();
    const reg = new RedisAgentRegistry({
      client: redis,
      prefix: PREFIX,
      ttlMs: 30_000,
      heartbeatMs: 10_000,
    });
    await reg.register(card('mine'));
    // Another process registered "theirs" directly with the same TTL.
    redis.seed(key('theirs'), JSON.stringify(card('theirs')), 30_000);

    // Heartbeats fire past the TTL; only "mine" is refreshed.
    await vi.advanceTimersByTimeAsync(40_000);

    expect(await reg.get('mine')).not.toBeNull();
    expect(await reg.get('theirs')).toBeNull();
    await reg.close();
  });

  it('close() stops the heartbeat and gracefully deregisters owned cards', async () => {
    const redis = new FakeRedis();
    const reg = new RedisAgentRegistry({
      client: redis,
      prefix: PREFIX,
      ttlMs: 30_000,
      heartbeatMs: 10_000,
    });
    await reg.register(card('a'));
    await reg.close();

    // Graceful deregister: gone immediately, not waiting for TTL.
    expect(await reg.get('a')).toBeNull();

    // And the heartbeat must not keep firing after close.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await reg.get('a')).toBeNull();
  });

  it('does not quit the injected client on close (caller owns it)', async () => {
    const redis = new FakeRedis();
    const reg = new RedisAgentRegistry({ client: redis, prefix: PREFIX });
    await reg.register(card('a'));
    await reg.close();
    expect(redis.quitCalls).toBe(0);
  });
});
