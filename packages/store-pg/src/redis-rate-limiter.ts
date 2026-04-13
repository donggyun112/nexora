/**
 * Redis-backed sliding window rate limiter.
 *
 * Distributed-safe: multiple gateway instances share counters via Redis.
 * Uses sorted sets with score = timestamp for precise sliding windows.
 *
 * Drop-in replacement for the in-memory createRateLimiter() from gateway.
 */

export interface RedisRateLimiterOptions {
  /** Redis client (ioredis-compatible) */
  redis: RedisLike;
  /** Max requests per window. Default: 60 */
  maxRequests?: number;
  /** Window size in milliseconds. Default: 60_000 */
  windowMs?: number;
  /** Key prefix. Default: 'nexora:rl:' */
  prefix?: string;
}

/** Minimal Redis interface — works with ioredis or any compatible client */
export interface RedisLike {
  multi(): RedisPipeline;
}

export interface RedisPipeline {
  zremrangebyscore(key: string, min: number | string, max: number | string): RedisPipeline;
  zadd(key: string, score: number, member: string): RedisPipeline;
  zcard(key: string): RedisPipeline;
  pexpire(key: string, ms: number): RedisPipeline;
  pipeline_exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface DistributedRateLimiter {
  allow(tenantId: string): Promise<boolean>;
}

export function createRedisRateLimiter(options: RedisRateLimiterOptions): DistributedRateLimiter {
  const maxRequests = options.maxRequests ?? 60;
  const windowMs = options.windowMs ?? 60_000;
  const prefix = options.prefix ?? 'nexora:rl:';

  return {
    async allow(tenantId: string): Promise<boolean> {
      const key = `${prefix}${tenantId}`;
      const now = Date.now();
      const windowStart = now - windowMs;
      const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;

      const pipeline = options.redis.multi();
      pipeline.zremrangebyscore(key, 0, windowStart);
      pipeline.zadd(key, now, member);
      pipeline.zcard(key);
      pipeline.pexpire(key, windowMs);

      const results = await pipeline.pipeline_exec();
      if (!results) return false;
      const count = results[2]?.[1] as number;
      return count <= maxRequests;
    },
  };
}
