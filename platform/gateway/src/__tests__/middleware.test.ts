import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  createApiKeyAuth,
  createRateLimiter,
  createSecureResolver,
  RateLimitError,
} from '../middleware.js';

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe('createApiKeyAuth', () => {
  const auth = createApiKeyAuth({
    keys: new Map([['sk-abc', 'startup'], ['sk-xyz', 'enterprise']]),
  });

  it('resolves tenant from Bearer token', () => {
    expect(auth(fakeReq({ authorization: 'Bearer sk-abc' }))).toBe('startup');
    expect(auth(fakeReq({ authorization: 'Bearer sk-xyz' }))).toBe('enterprise');
  });

  it('resolves tenant from X-API-Key header', () => {
    expect(auth(fakeReq({ 'x-api-key': 'sk-abc' }))).toBe('startup');
  });

  it('returns null for missing key', () => {
    expect(auth(fakeReq())).toBeNull();
  });

  it('returns null for unknown key', () => {
    expect(auth(fakeReq({ authorization: 'Bearer sk-unknown' }))).toBeNull();
  });

  it('prefers Authorization header over X-API-Key', () => {
    expect(auth(fakeReq({
      authorization: 'Bearer sk-abc',
      'x-api-key': 'sk-xyz',
    }))).toBe('startup');
  });
});

describe('createRateLimiter', () => {
  it('allows requests within limit', () => {
    const limiter = createRateLimiter({ maxRequests: 3, windowMs: 1000 });
    expect(limiter.allow('t1')).toBe(true);
    expect(limiter.allow('t1')).toBe(true);
    expect(limiter.allow('t1')).toBe(true);
  });

  it('blocks requests over limit', () => {
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 1000 });
    limiter.allow('t1');
    limiter.allow('t1');
    expect(limiter.allow('t1')).toBe(false);
  });

  it('tracks tenants independently', () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(limiter.allow('t1')).toBe(true);
    expect(limiter.allow('t2')).toBe(true);
    expect(limiter.allow('t1')).toBe(false);
    expect(limiter.allow('t2')).toBe(false);
  });

  it('resets state', () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1000 });
    limiter.allow('t1');
    expect(limiter.allow('t1')).toBe(false);
    limiter.reset();
    expect(limiter.allow('t1')).toBe(true);
  });

  it('allows again after window expires', async () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 50 });
    limiter.allow('t1');
    expect(limiter.allow('t1')).toBe(false);
    await new Promise(r => setTimeout(r, 60));
    expect(limiter.allow('t1')).toBe(true);
  });
});

describe('createSecureResolver', () => {
  it('returns tenantId when auth passes and within rate limit', () => {
    const resolve = createSecureResolver({
      auth: { keys: new Map([['sk-abc', 'startup']]) },
      rateLimit: { maxRequests: 10, windowMs: 1000 },
    });
    expect(resolve(fakeReq({ authorization: 'Bearer sk-abc' }))).toBe('startup');
  });

  it('returns null when auth fails', () => {
    const resolve = createSecureResolver({
      auth: { keys: new Map([['sk-abc', 'startup']]) },
    });
    expect(resolve(fakeReq({ authorization: 'Bearer bad' }))).toBeNull();
  });

  it('throws RateLimitError when rate-limited', () => {
    const resolve = createSecureResolver({
      auth: { keys: new Map([['sk-abc', 'startup']]) },
      rateLimit: { maxRequests: 1, windowMs: 1000 },
    });
    resolve(fakeReq({ authorization: 'Bearer sk-abc' }));
    expect(() => resolve(fakeReq({ authorization: 'Bearer sk-abc' }))).toThrow(RateLimitError);
  });

  it('works without rate limit', () => {
    const resolve = createSecureResolver({
      auth: { keys: new Map([['sk-abc', 'startup']]) },
    });
    expect(resolve(fakeReq({ authorization: 'Bearer sk-abc' }))).toBe('startup');
  });
});
