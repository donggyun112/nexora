import { describe, expect, it, vi } from 'vitest';
import {
  createAnthropicKeyResolver,
  parseBlob,
  shouldOverwriteStoredToken,
  type AnthropicKeyResolverDeps,
  type AnthropicOAuthSource,
} from '../anthropic-auth.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

type Cred = { type: 'oauth'; access: string; refresh: string; expires: number };

function makeDeps(overrides: Partial<AnthropicKeyResolverDeps> = {}): {
  deps: AnthropicKeyResolverDeps;
  refresh: ReturnType<typeof vi.fn>;
  toAuth: ReturnType<typeof vi.fn>;
  writeBack: ReturnType<typeof vi.fn>;
  readSource: ReturnType<typeof vi.fn>;
  clock: { now: number };
} {
  const clock = { now: NOW };
  // 기본 refresh: 입력 credential 을 그대로 돌려준다 → rotated=false.
  const refresh = vi.fn(async (credential: Cred) => credential);
  // 기본 toAuth: anthropic 은 access token 을 그대로 apiKey 로 쓴다.
  const toAuth = vi.fn(async (credential: Cred) => ({ apiKey: credential.access }));
  const writeBack = vi.fn();
  const readSource = vi.fn((): AnthropicOAuthSource | null => null);
  const deps: AnthropicKeyResolverDeps = {
    readSource,
    oauth: {
      refresh: refresh as unknown as AnthropicKeyResolverDeps['oauth']['refresh'],
      toAuth: toAuth as unknown as AnthropicKeyResolverDeps['oauth']['toAuth'],
    },
    writeBack,
    staticApiKey: () => undefined,
    envOAuthToken: () => undefined,
    now: () => clock.now,
    ...overrides,
  };
  return { deps, refresh, toAuth, writeBack, readSource, clock };
}

/** 테스트별 refresh 동작을 주입할 oauth 포트. toAuth 는 access 를 그대로 apiKey 로 파생. */
function oauthPort(refresh: ReturnType<typeof vi.fn>): AnthropicKeyResolverDeps['oauth'] {
  return {
    refresh: refresh as unknown as AnthropicKeyResolverDeps['oauth']['refresh'],
    toAuth: (async (credential: Cred) => ({
      apiKey: credential.access,
    })) as unknown as AnthropicKeyResolverDeps['oauth']['toAuth'],
  };
}

describe('createAnthropicKeyResolver', () => {
  it('returns a still-valid source token without any token exchange', async () => {
    const { deps, refresh, toAuth } = makeDeps({
      readSource: () => ({ origin: 'keychain', access: 'tok-fresh', refresh: 'r1', expires: NOW + 4 * HOUR }),
    });
    const resolve = createAnthropicKeyResolver(deps);
    // expires - now = 4h > buffer → 교환 없이 toAuth 로만 파생한다(네트워크 0회).
    await expect(resolve()).resolves.toBe('tok-fresh');
    expect(refresh).not.toHaveBeenCalled();
    expect(toAuth).toHaveBeenCalledTimes(1);
  });

  it('caches the resolved key and does not re-read the source within validity', async () => {
    const readSource = vi.fn(() => ({ origin: 'keychain' as const, access: 'tok', refresh: 'r1', expires: NOW + 4 * HOUR }));
    const { deps } = makeDeps({ readSource });
    const resolve = createAnthropicKeyResolver(deps);
    await resolve();
    await resolve();
    expect(readSource).toHaveBeenCalledTimes(1);
  });

  it('refreshes via refresh_token and writes back when the endpoint rotates the token', async () => {
    const refresh = vi.fn(async () => ({ type: 'oauth', access: 'tok-new', refresh: 'r2', expires: NOW + 8 * HOUR }));
    const writeBack = vi.fn();
    const { deps } = makeDeps({
      readSource: () => ({ origin: 'file', file: '/tmp/c.json', access: 'tok-old', refresh: 'r1', expires: NOW - HOUR }),
      oauth: oauthPort(refresh),
      writeBack,
    });
    const resolve = createAnthropicKeyResolver(deps);
    await expect(resolve()).resolves.toBe('tok-new');
    expect(writeBack).toHaveBeenCalledTimes(1);
    expect(writeBack.mock.calls[0][1]).toMatchObject({ access: 'tok-new', refresh: 'r2' });
  });

  it('does not write back when the endpoint returns the same token (no rotation)', async () => {
    const { deps, writeBack, refresh } = makeDeps({
      readSource: () => ({ origin: 'file', file: '/tmp/c.json', access: 'tok', refresh: 'r1', expires: NOW - HOUR }),
    });
    const resolve = createAnthropicKeyResolver(deps);
    await resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(writeBack).not.toHaveBeenCalled();
  });

  it('prefers a static ANTHROPIC_API_KEY and never reads the OAuth source', async () => {
    const { deps, readSource, refresh, toAuth } = makeDeps({ staticApiKey: () => 'sk-ant-static' });
    const resolve = createAnthropicKeyResolver(deps);
    await expect(resolve()).resolves.toBe('sk-ant-static');
    expect(readSource).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(toAuth).not.toHaveBeenCalled();
  });

  it('falls back to the env OAuth token when no source credential exists', async () => {
    const { deps } = makeDeps({ readSource: () => null, envOAuthToken: () => 'env-tok' });
    const resolve = createAnthropicKeyResolver(deps);
    await expect(resolve()).resolves.toBe('env-tok');
  });

  it('throws when no credential is available anywhere', async () => {
    const { deps } = makeDeps({ readSource: () => null, envOAuthToken: () => undefined });
    const resolve = createAnthropicKeyResolver(deps);
    await expect(resolve()).rejects.toThrow(/자격증명/);
  });

  it('exchanges once when the source token is inside the refresh buffer', async () => {
    const { deps, refresh } = makeDeps({
      // 만료 2분 전 — 아직 유효하지만 버퍼(5분) 안이라 선제 교환한다.
      readSource: () => ({ origin: 'keychain', access: 'tok', refresh: 'r1', expires: NOW + 2 * 60 * 1000 }),
    });
    const resolve = createAnthropicKeyResolver(deps);
    await resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent callers into a single refresh (single-flight)', async () => {
    let resolveRefresh: (v: Cred) => void = () => {};
    const refresh = vi.fn(
      () =>
        new Promise((res) => {
          resolveRefresh = res as (v: Cred) => void;
        }),
    );
    const { deps } = makeDeps({
      readSource: () => ({ origin: 'keychain', access: 'tok', refresh: 'r1', expires: NOW - HOUR }),
      oauth: oauthPort(refresh),
    });
    const resolve = createAnthropicKeyResolver(deps);
    const p1 = resolve();
    const p2 = resolve();
    resolveRefresh({ type: 'oauth', access: 'tok-new', refresh: 'r2', expires: NOW + 8 * HOUR });
    await Promise.all([p1, p2]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('returns the access token unchanged when the source has no refresh token', async () => {
    const { deps, refresh, toAuth } = makeDeps({
      readSource: () => ({ origin: 'keychain', access: 'tok-only', expires: NOW - HOUR }),
    });
    const resolve = createAnthropicKeyResolver(deps);
    await expect(resolve()).resolves.toBe('tok-only');
    expect(refresh).not.toHaveBeenCalled();
    expect(toAuth).not.toHaveBeenCalled();
  });

  it('rejects when the refresh endpoint fails, and retries (no poisoned cache) on the next call', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ type: 'oauth', access: 'tok-recovered', refresh: 'r2', expires: NOW + 8 * HOUR });
    const { deps } = makeDeps({
      readSource: () => ({ origin: 'keychain', access: 'tok', refresh: 'r1', expires: NOW - HOUR }),
      oauth: oauthPort(refresh),
    });
    const resolve = createAnthropicKeyResolver(deps);
    await expect(resolve()).rejects.toThrow(/network down/);
    await expect(resolve()).resolves.toBe('tok-recovered');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('throws when toAuth yields no apiKey', async () => {
    const { deps } = makeDeps({
      readSource: () => ({ origin: 'keychain', access: 'tok', refresh: 'r1', expires: NOW + 4 * HOUR }),
      oauth: {
        refresh: (async (c: Cred) => c) as unknown as AnthropicKeyResolverDeps['oauth']['refresh'],
        toAuth: (async () => ({})) as unknown as AnthropicKeyResolverDeps['oauth']['toAuth'],
      },
    });
    const resolve = createAnthropicKeyResolver(deps);
    await expect(resolve()).rejects.toThrow(/apiKey/);
  });
});

describe('parseBlob', () => {
  it('extracts access/refresh/expires from a Claude Code credential blob', () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 123, scopes: ['x'] },
    });
    expect(parseBlob(raw)).toEqual({ access: 'a', refresh: 'r', expires: 123 });
  });

  it('coerces a missing/non-numeric expiresAt to 0', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } });
    expect(parseBlob(raw)?.expires).toBe(0);
  });

  it('returns null on malformed JSON or a blob without an access token', () => {
    expect(parseBlob('not json')).toBeNull();
    expect(parseBlob(JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }))).toBeNull();
    expect(parseBlob(JSON.stringify({}))).toBeNull();
  });
});

describe('shouldOverwriteStoredToken', () => {
  it('overwrites only when our token expires strictly later than the stored one', () => {
    expect(shouldOverwriteStoredToken(100, 200)).toBe(true);
    expect(shouldOverwriteStoredToken(200, 200)).toBe(false); // equal — assume a concurrent writer won
    expect(shouldOverwriteStoredToken(300, 200)).toBe(false); // stored is newer — don't clobber
    expect(shouldOverwriteStoredToken(0, 0)).toBe(false); // unknown expiry both sides — skip
  });
});
