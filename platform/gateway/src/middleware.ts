/**
 * Gateway middleware — auth + rate-limit for production deployments.
 *
 * These utilities wrap the HttpAdapter's `resolveTenant` hook to add:
 * 1. API key authentication (per-tenant static keys)
 * 2. Sliding-window rate limiting (per-tenant, in-memory)
 *
 * Both are opt-in: import what you need and compose with your
 * existing `resolveTenant` function.
 */

import type { IncomingMessage } from 'node:http';

// ─── API Key Auth ──────────────────────────────────────────────────────────

export interface ApiKeyAuthOptions {
  /**
   * Map of API key → tenantId.
   * The key is looked up from the `Authorization: Bearer <key>` header
   * or the `X-API-Key` header.
   */
  keys: ReadonlyMap<string, string>;
}

/**
 * Returns a `resolveTenant` function that authenticates via API key.
 *
 * Usage:
 * ```ts
 * const resolveTenant = createApiKeyAuth({
 *   keys: new Map([['sk-abc', 'startup'], ['sk-xyz', 'enterprise']]),
 * });
 * const adapter = new HttpAdapter({ resolveTenant });
 * ```
 */
export function createApiKeyAuth(
  options: ApiKeyAuthOptions,
): (req: IncomingMessage) => string | null {
  const { keys } = options;

  return (req: IncomingMessage): string | null => {
    const authHeader = req.headers['authorization'];
    const apiKeyHeader = req.headers['x-api-key'];

    let key: string | undefined;

    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      key = authHeader.slice(7).trim();
    } else if (typeof apiKeyHeader === 'string') {
      key = apiKeyHeader.trim();
    }

    if (!key) return null;
    return keys.get(key) ?? null;
  };
}

// ─── Rate Limiter ──────────────────────────────────────────────────────────

export interface RateLimitOptions {
  /** Maximum requests per window. Default: 60 */
  maxRequests?: number;
  /** Window size in milliseconds. Default: 60_000 (1 minute) */
  windowMs?: number;
}

interface WindowState {
  timestamps: number[];
}

/**
 * In-memory sliding-window rate limiter, keyed by tenant.
 *
 * Usage:
 * ```ts
 * const limiter = createRateLimiter({ maxRequests: 100, windowMs: 60_000 });
 *
 * // In your resolveTenant:
 * const tenantId = resolveFromHeader(req);
 * if (tenantId && !limiter.allow(tenantId)) {
 *   return null; // 401 — or throw for 429
 * }
 * ```
 *
 * For production deployments with multiple gateway instances, replace with
 * a Redis-backed implementation sharing counters across processes.
 */
export interface RateLimiter {
  /** Returns true if the request is allowed, false if rate-limited. */
  allow(tenantId: string): boolean;
  /** Reset all state (useful for testing). */
  reset(): void;
}

export function createRateLimiter(options: RateLimitOptions = {}): RateLimiter {
  const maxRequests = options.maxRequests ?? 60;
  const windowMs = options.windowMs ?? 60_000;
  const state = new Map<string, WindowState>();

  return {
    allow(tenantId: string): boolean {
      const now = Date.now();
      const cutoff = now - windowMs;

      let entry = state.get(tenantId);
      if (!entry) {
        entry = { timestamps: [] };
        state.set(tenantId, entry);
      }

      // Prune timestamps outside the window
      entry.timestamps = entry.timestamps.filter(t => t > cutoff);

      if (entry.timestamps.length >= maxRequests) {
        return false;
      }

      entry.timestamps.push(now);
      return true;
    },

    reset(): void {
      state.clear();
    },
  };
}

// ─── Composable resolveTenant with auth + rate-limit ───────────────────────

export interface SecureResolverOptions {
  /** API key auth config */
  auth: ApiKeyAuthOptions;
  /** Rate limit config (optional) */
  rateLimit?: RateLimitOptions;
}

export class RateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(tenantId: string, windowMs: number) {
    super(`Rate limit exceeded for tenant ${tenantId}`);
    this.name = 'RateLimitError';
    this.retryAfterMs = windowMs;
  }
}

/**
 * Compose API key auth + rate limiting into a single `resolveTenant` function.
 *
 * Returns null on auth failure (→ 401).
 * Throws RateLimitError on rate-limit exceeded (→ caller maps to 429).
 */
export function createSecureResolver(
  options: SecureResolverOptions,
): (req: IncomingMessage) => string | null {
  const authFn = createApiKeyAuth(options.auth);
  const limiter = options.rateLimit ? createRateLimiter(options.rateLimit) : null;
  const windowMs = options.rateLimit?.windowMs ?? 60_000;

  return (req: IncomingMessage): string | null => {
    const tenantId = authFn(req);
    if (tenantId === null) return null;

    if (limiter && !limiter.allow(tenantId)) {
      throw new RateLimitError(tenantId, windowMs);
    }

    return tenantId;
  };
}
