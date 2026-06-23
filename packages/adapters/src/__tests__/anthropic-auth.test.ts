import { describe, expect, it, vi } from 'vitest';
import {
  createAnthropicKeyResolver,
  parseBlob,
  shouldOverwriteStoredToken,
  type AnthropicKeyResolverDeps,
  type AnthropicOAuthSource,
} from '../anthropic-auth.js';

const HOUR = 60 * 60 * 1000;

function makeDeps(overrides: Partial<AnthropicKeyResolverDeps> = {}): {
  deps: AnthropicKeyResolverDeps;
  refreshOAuth: ReturnType<typeof vi.fn>;
  writeBack: ReturnType<typeof vi.fn>;
  readSource: ReturnType<typeof vi.fn>;
  clock: { now: number };
} {
  const clock = { now: 1_000_000_000_000 };
  const refreshOAuth = vi.fn(async (_id: string, creds: Record<string, { access: string; refresh: string; expires: number }>) => ({
    apiKey: creds.anthropic.access,
    newCredentials: creds.anthropic, // echo by default → rotated=false
  }));
  const writeBack = vi.fn();
  const readSource = vi.fn((): AnthropicOAuthSource | null => null);
  const deps: AnthropicKeyResolverDeps = {
    readSource,
    refreshOAuth: refreshOAuth as unknown as AnthropicKeyResolverDeps['refreshOAuth'],
    writeBack,
    staticApiKey: () => undefined,
    envOAuthToken: () => undefined,
    now: () => clock.now,
    ...overrides,
  };
  return { deps, refreshOAuth, writeBack, readSource, clock };
}

describe('createAnthropicKeyResolver', () => {
  it('returns a still-valid source token without calling the OAuth refresh endpoint', async () => {
    const { deps, refreshOAuth } = makeDeps({
      readSource: () => ({ origin: 'keychain', access: 'tok-fresh', refresh: 'r1', expires: 1_000_000_000_000 + 4 * HOUR }),
    });
    const resolve = createAnthropicKeyResolver(deps);
    // expires - now = 4h > buffer → echo path; pi-ai still called but no rotation/network
    await expect(resolve()).resolves.toBe('tok-fresh');
    expect(refreshOAuth).toHaveBeenCalledTimes(1);
  });

  it('caches the resolved key and does not re-read the source within validity', async () => {
    const readSource = vi.fn(() => ({ origin: 'keychain' as const, access: 'tok', refresh: 'r1', expires: 1_000_000_000_000 + 4 * HOUR }));
    const { deps } = makeDeps({ readSource });
    const resolve = createAnthropicKeyResolver(deps);
    await resolve();
    await resolve();
    expect(readSource).toHaveBeenCalledTimes(1);
  });

  it('refreshes via refresh_token and writes back when the endpoint rotates the token', async () => {
    const refreshOAuth = vi.fn(async () => ({
      apiKey: 'tok-new',
      newCredentials: { access: 'tok-new', refresh: 'r2', expires: 1_000_000_000_000 + 8 * HOUR },
    }));
    const writeBack = vi.fn();
    const { deps } = makeDeps({
      readSource: () => ({ origin: 'file', file: '/tmp/c.json', access: 'tok-old', refresh: 'r1', expires: 1_000_000_000_000 - HOUR }),
      refreshOAuth: refreshOAuth as unknown as AnthropicKeyResolverDeps['refreshOAuth'],
      writeBack,
    });
    const resolve = createAnthropicKeyResolver(deps);
    await expect(resolve()).resolves.toBe('tok-new');
    expect(writeBack).toHaveBeenCalledTimes(1);
    expect(writeBack.mock.calls[0][1]).toMatchObject({ access: 'tok-new', refresh: 'r2' });
  });

  it('does not write back when the endpoint echoes the same token (no rotation)', async () => {
    const { deps, writeBack } = makeDeps({
      readSource: () => ({ origin: 'file', file: '/tmp/c.json', access: 'tok', refresh: 'r1', expires: 1_000_000_000_000 - HOUR }),
    });
    const resolve = createAnthropicKeyResolver(deps);
    await resolve();
    expect(writeBack).not.toHaveBeenCalled();
  });

  it('prefers a static ANTHROPIC_API_KEY and never reads the OAuth source', async () => {
    const { deps, readSource, refreshOAuth } = makeDeps({ staticApiKey: () => 'sk-ant-static' });
    const resolve = createAnthropicKeyResolver(deps);
    await expect(resolve()).resolves.toBe('sk-ant-static');
    expect(readSource).not.toHaveBeenCalled();
    expect(refreshOAuth).not.toHaveBeenCalled();
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

  it('serializes concurrent callers into a single refresh (single-flight)', async () => {
    let resolveRefresh: (v: { apiKey: string; newCredentials: { access: string; refresh: string; expires: number } }) => void = () => {};
    const refreshOAuth = vi.fn(
      () =>
        new Promise((res) => {
          resolveRefresh = res;
        }),
    );
    const { deps } = makeDeps({
      readSource: () => ({ origin: 'keychain', access: 'tok', refresh: 'r1', expires: 1_000_000_000_000 - HOUR }),
      refreshOAuth: refreshOAuth as unknown as AnthropicKeyResolverDeps['refreshOAuth'],
    });
    const resolve = createAnthropicKeyResolver(deps);
    const p1 = resolve();
    const p2 = resolve();
    resolveRefresh({ apiKey: 'tok-new', newCredentials: { access: 'tok-new', refresh: 'r2', expires: 1_000_000_000_000 + 8 * HOUR } });
    await Promise.all([p1, p2]);
    expect(refreshOAuth).toHaveBeenCalledTimes(1);
  });

  it('returns the access token unchanged when the source has no refresh token', async () => {
    const { deps, refreshOAuth } = makeDeps({
      readSource: () => ({ origin: 'keychain', access: 'tok-only', expires: 1_000_000_000_000 - HOUR }),
    });
    const resolve = createAnthropicKeyResolver(deps);
    await expect(resolve()).resolves.toBe('tok-only');
    expect(refreshOAuth).not.toHaveBeenCalled();
  });

  it('rejects when the refresh endpoint fails, and retries (no poisoned cache) on the next call', async () => {
    const refreshOAuth = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        apiKey: 'tok-recovered',
        newCredentials: { access: 'tok-recovered', refresh: 'r2', expires: 1_000_000_000_000 + 8 * HOUR },
      });
    const { deps } = makeDeps({
      readSource: () => ({ origin: 'keychain', access: 'tok', refresh: 'r1', expires: 1_000_000_000_000 - HOUR }),
      refreshOAuth: refreshOAuth as unknown as AnthropicKeyResolverDeps['refreshOAuth'],
    });
    const resolve = createAnthropicKeyResolver(deps);
    await expect(resolve()).rejects.toThrow(/network down/);
    await expect(resolve()).resolves.toBe('tok-recovered');
    expect(refreshOAuth).toHaveBeenCalledTimes(2);
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
