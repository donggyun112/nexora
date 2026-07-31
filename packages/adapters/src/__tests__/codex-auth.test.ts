/**
 * runtime/codex-auth.ts `resolveCodexApiKey` — 캐시 + single-flight + 선제 refresh.
 *
 * 실제 refresh_token 교환은 pi-ai openai-codex provider 의 OAuth flow 가 하므로 provider
 * 모듈을 mock 한다. pi-ai 0.80.10 부터 flow 는 refresh(무조건 교환) / toAuth(파생) 로 쪼개져
 * 있고, "만료면 교환" 판단은 codex-auth 가 직접 한다 — 그 경계를 여기서 검증한다.
 * 모듈 레벨 캐시/inFlight 상태가 테스트 간 새도록 매 테스트 vi.resetModules + 동적 import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PROVIDER_MODULE = '@earendil-works/pi-ai/providers/openai-codex';

const refresh = vi.fn();
const toAuth = vi.fn();

function jwtWithExp(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

function writeAuth(dir: string, access: string, refreshToken: string): void {
  writeFileSync(
    path.join(dir, 'auth.json'),
    JSON.stringify({ tokens: { access_token: access, refresh_token: refreshToken } }),
  );
}

async function loadResolve(): Promise<() => Promise<string>> {
  return (await import('../codex-auth.js')).resolveCodexApiKey;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

describe('resolveCodexApiKey', () => {
  let dir: string;

  beforeEach(() => {
    vi.resetModules();
    refresh.mockReset();
    toAuth.mockReset();
    dir = mkdtempSync(path.join(tmpdir(), 'codex-resolve-'));
    process.env.CODEX_HOME = dir;
    // 기본 refresh: 입력 credential 을 그대로 돌려준다 → rotated=false.
    refresh.mockImplementation(async (credential: { access: string }) => credential);
    // openai-codex 는 access token 을 그대로 apiKey 로 쓴다.
    toAuth.mockImplementation(async (credential: { access: string }) => ({ apiKey: credential.access }));
    vi.doMock(PROVIDER_MODULE, () => ({
      openaiCodexProvider: () => ({ auth: { oauth: { refresh, toAuth } } }),
    }));
  });

  afterEach(() => {
    delete process.env.CODEX_HOME;
    vi.doUnmock(PROVIDER_MODULE);
  });

  it('유효 토큰이면 교환 없이 파생하고 캐시 — refresh 0회, toAuth 1회', async () => {
    const access = jwtWithExp(nowSec() + 3600);
    writeAuth(dir, access, 'r1');
    const resolve = await loadResolve();
    expect(await resolve()).toBe(access);
    expect(await resolve()).toBe(access);
    expect(refresh).not.toHaveBeenCalled();
    expect(toAuth).toHaveBeenCalledTimes(1);
  });

  it('single-flight: 동시 호출이 하나의 교환을 공유', async () => {
    writeAuth(dir, jwtWithExp(nowSec() + 60), 'r1'); // 1분 남음 → 교환 경로
    let calls = 0;
    refresh.mockImplementation(async (credential: { access: string; refresh: string; expires: number }) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return credential;
    });
    const resolve = await loadResolve();
    const out = await Promise.all([resolve(), resolve(), resolve()]);
    expect(new Set(out).size).toBe(1);
    expect(calls).toBe(1);
  });

  it('만료 버퍼 안이면 교환하고 회전된 토큰을 파일에 write-back', async () => {
    const oldAccess = jwtWithExp(nowSec() + 60); // 1분 남음 < 5분 버퍼
    writeAuth(dir, oldAccess, 'r-old');
    const newExpMs = Date.now() + 3600_000;
    const newAccess = jwtWithExp(Math.floor(newExpMs / 1000));
    refresh.mockResolvedValue({ type: 'oauth', access: newAccess, refresh: 'r-new', expires: newExpMs });
    const resolve = await loadResolve();
    expect(await resolve()).toBe(newAccess);
    const written = JSON.parse(readFileSync(path.join(dir, 'auth.json'), 'utf-8'));
    expect(written.tokens.refresh_token).toBe('r-new');
    expect(written.tokens.access_token).toBe(newAccess);
  });

  it('회전 없으면 write-back 하지 않는다', async () => {
    const access = jwtWithExp(nowSec() + 60);
    writeAuth(dir, access, 'r1');
    const resolve = await loadResolve();
    await resolve();
    const written = JSON.parse(readFileSync(path.join(dir, 'auth.json'), 'utf-8'));
    expect(written.tokens).toEqual({ access_token: access, refresh_token: 'r1' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // 회귀: 캐시 만료는 JWT exp(realExpiry) 기준이어야 한다. 버퍼를 이중 차감하면
  // (BUFFER, 2*BUFFER) 구간 토큰이 매 호출 재파생돼 캐시가 무력화된다.
  it('이중 차감 없음: 버퍼와 2배버퍼 사이 토큰도 2번째 호출은 캐시 히트', async () => {
    writeAuth(dir, jwtWithExp(nowSec() + 420), 'r1'); // 7분 남음 (버퍼 5분 < 7분 < 10분)
    const resolve = await loadResolve();
    await resolve();
    await resolve();
    expect(toAuth).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('JWT decode 실패면 즉시 교환한다', async () => {
    writeAuth(dir, 'not-a-jwt', 'r1');
    const resolve = await loadResolve();
    await resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('toAuth 가 apiKey 를 안 주면 throw', async () => {
    writeAuth(dir, jwtWithExp(nowSec() + 3600), 'r1');
    toAuth.mockResolvedValue({});
    const resolve = await loadResolve();
    await expect(resolve()).rejects.toThrow(/apiKey/);
  });
});
