/**
 * runtime/codex-auth.ts `resolveCodexApiKey` — 캐시 + single-flight + 선제 refresh.
 *
 * 실제 refresh_token 교환은 pi-ai 의 getOAuthApiKey 가 하므로 그걸 mock 한다.
 * 모듈 레벨 캐시/inFlight 상태가 테스트 간 새도록 매 테스트 vi.resetModules + 동적 import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const getOAuthApiKey = vi.fn();

function jwtWithExp(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

function writeAuth(dir: string, access: string, refresh: string): void {
  writeFileSync(
    path.join(dir, 'auth.json'),
    JSON.stringify({ tokens: { access_token: access, refresh_token: refresh } }),
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
    getOAuthApiKey.mockReset();
    dir = mkdtempSync(path.join(tmpdir(), 'codex-resolve-'));
    process.env.CODEX_HOME = dir;
    // 미회전 응답: pi-ai 는 refresh 안 하면 입력 creds 를 그대로 echo 한다.
    getOAuthApiKey.mockImplementation(async (_id: string, creds: Record<string, unknown>) => ({
      apiKey: 'KEY1',
      newCredentials: (creds as Record<string, unknown>)['openai-codex'],
    }));
    vi.doMock('@earendil-works/pi-ai/oauth', () => ({ getOAuthApiKey }));
  });

  afterEach(() => {
    delete process.env.CODEX_HOME;
    vi.doUnmock('@earendil-works/pi-ai/oauth');
  });

  it('유효 토큰이면 캐시 — getOAuthApiKey 는 1회만', async () => {
    writeAuth(dir, jwtWithExp(nowSec() + 3600), 'r1');
    const resolve = await loadResolve();
    expect(await resolve()).toBe('KEY1');
    expect(await resolve()).toBe('KEY1');
    expect(getOAuthApiKey).toHaveBeenCalledTimes(1);
  });

  it('single-flight: 동시 호출이 하나의 refresh 를 공유', async () => {
    writeAuth(dir, jwtWithExp(nowSec() + 3600), 'r1');
    let calls = 0;
    getOAuthApiKey.mockImplementation(async (_id: string, creds: Record<string, unknown>) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { apiKey: 'KEY1', newCredentials: (creds as Record<string, unknown>)['openai-codex'] };
    });
    const resolve = await loadResolve();
    const out = await Promise.all([resolve(), resolve(), resolve()]);
    expect(out).toEqual(['KEY1', 'KEY1', 'KEY1']);
    expect(calls).toBe(1);
  });

  it('만료 버퍼 안이면 refresh 하고 회전된 토큰을 파일에 write-back', async () => {
    writeAuth(dir, jwtWithExp(nowSec() + 60), 'r-old'); // 1분 남음 < 5분 버퍼
    const newExpMs = Date.now() + 3600_000;
    getOAuthApiKey.mockResolvedValue({
      apiKey: 'KEY2',
      newCredentials: { access: jwtWithExp(Math.floor(newExpMs / 1000)), refresh: 'r-new', expires: newExpMs },
    });
    const resolve = await loadResolve();
    expect(await resolve()).toBe('KEY2');
    const written = JSON.parse(readFileSync(path.join(dir, 'auth.json'), 'utf-8'));
    expect(written.tokens.refresh_token).toBe('r-new');
    expect(written.tokens.access_token).not.toBe(jwtWithExp(nowSec() + 60));
  });

  // 회귀: 미회전 시 getOAuthApiKey 는 우리가 넘긴 (줄인) expires 를 echo 한다.
  // 그 값을 캐싱하면 만료가 realExpiry - 2*BUFFER 로 이중 차감돼 캐시가 조기 만료된다.
  // realExpiry 를 독립 계산해 캐싱하므로 (BUFFER, 2*BUFFER) 사이 토큰도 2번째 호출이 캐시 히트여야 한다.
  it('이중 차감 없음: 버퍼와 2배버퍼 사이 토큰도 2번째 호출은 캐시 히트', async () => {
    writeAuth(dir, jwtWithExp(nowSec() + 420), 'r1'); // 7분 남음 (버퍼 5분 < 7분 < 10분)
    const resolve = await loadResolve();
    await resolve();
    await resolve();
    expect(getOAuthApiKey).toHaveBeenCalledTimes(1);
  });
});
