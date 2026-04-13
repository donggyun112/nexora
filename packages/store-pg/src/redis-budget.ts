/**
 * Redis-backed distributed budget tracker.
 *
 * Shared across multiple gateway/agent instances via Redis.
 * Uses atomic INCRBYFLOAT for concurrent-safe cost accumulation.
 */

export interface RedisBudgetOptions {
  /** Redis client (ioredis-compatible) */
  redis: RedisBudgetClient;
  /** Key prefix. Default: 'nexora:budget:' */
  prefix?: string;
}

export interface RedisBudgetClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  incrbyfloat(key: string, increment: number): Promise<string>;
}

export interface DistributedBudgetTracker {
  getSpent(scope: string): Promise<number>;
  addCost(scope: string, cost: number): Promise<number>;
  setLimit(scope: string, limit: number): Promise<void>;
  getLimit(scope: string): Promise<number | null>;
  isExceeded(scope: string): Promise<boolean>;
}

export function createRedisBudgetTracker(options: RedisBudgetOptions): DistributedBudgetTracker {
  const prefix = options.prefix ?? 'nexora:budget:';
  const { redis } = options;

  return {
    async getSpent(scope: string): Promise<number> {
      const val = await redis.get(`${prefix}${scope}:spent`);
      return val ? parseFloat(val) : 0;
    },

    async addCost(scope: string, cost: number): Promise<number> {
      const result = await redis.incrbyfloat(`${prefix}${scope}:spent`, cost);
      return parseFloat(result);
    },

    async setLimit(scope: string, limit: number): Promise<void> {
      await redis.set(`${prefix}${scope}:limit`, String(limit));
    },

    async getLimit(scope: string): Promise<number | null> {
      const val = await redis.get(`${prefix}${scope}:limit`);
      return val ? parseFloat(val) : null;
    },

    async isExceeded(scope: string): Promise<boolean> {
      const [spent, limit] = await Promise.all([
        this.getSpent(scope),
        this.getLimit(scope),
      ]);
      if (limit === null) return false;
      return spent >= limit;
    },
  };
}
