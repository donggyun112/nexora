/**
 * FakeRedis — in-process stand-in for the Redis surface the registry uses.
 *
 * Expiry is computed from `Date.now()`, so vitest fake timers
 * (`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`) drive TTL lapse and
 * heartbeat refresh deterministically — no real sleeping, no flakiness.
 *
 * Implements the structural `RegistryRedisLike` surface plus a couple of
 * test-only inspectors (`pttl`, `seed`, `quitCalls`).
 */

import type { RegistryRedisLike } from '../redis.js';

interface Entry {
  value: string;
  expireAt: number;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export class FakeRedis implements RegistryRedisLike {
  private readonly store = new Map<string, Entry>();
  quitCalls = 0;

  /** Lazily expire and return the live entry, or undefined. */
  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() >= e.expireAt) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async set(key: string, value: string, _mode: 'PX', ttlMs: number): Promise<'OK'> {
    this.store.set(key, { value, expireAt: Date.now() + ttlMs });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async pexpire(key: string, ttlMs: number): Promise<number> {
    const e = this.live(key);
    if (!e) return 0;
    e.expireAt = Date.now() + ttlMs;
    return 1;
  }

  async scan(
    _cursor: string,
    _matchOpt: 'MATCH',
    pattern: string,
    _countOpt: 'COUNT',
    _count: number,
  ): Promise<[string, string[]]> {
    const re = globToRegExp(pattern);
    const keys: string[] = [];
    for (const key of this.store.keys()) {
      if (this.live(key) && re.test(key)) keys.push(key);
    }
    return ['0', keys];
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.live(k)?.value ?? null);
  }

  async quit(): Promise<'OK'> {
    this.quitCalls++;
    return 'OK';
  }

  // ── test-only inspectors ──────────────────────────────────────────────
  /** Remaining TTL in ms, or -2 if the key is gone (mirrors Redis PTTL). */
  pttl(key: string): number {
    const e = this.live(key);
    return e ? e.expireAt - Date.now() : -2;
  }

  /** Write a key directly, bypassing the registry (simulates another process). */
  seed(key: string, value: string, ttlMs: number): void {
    this.store.set(key, { value, expireAt: Date.now() + ttlMs });
  }
}
