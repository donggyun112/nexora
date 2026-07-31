import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type { ModelAuth, OAuthCredential } from '@earendil-works/pi-ai';

// ChatGPT/Codex 구독 OAuth 로 openai-codex provider 를 인증한다 (Agent-workflow 레퍼런스와 동일
// 전략). restricted OpenAI 플랫폼 API 키는 gpt-5.x-codex 의 Responses API(api.responses.write)
// 스코프가 없어 401 이 난다 — 구독 OAuth 토큰은 그 제약을 받지 않는다.
//
// `codex login` 이 ~/.codex/auth.json 에 access/refresh 토큰을 저장한다. 만료 판단은 이 모듈이
// 하고(JWT exp + 버퍼), 교환이 필요하면 pi-ai openai-codex provider 의 OAuth flow 로 위임한다.
// refresh 로 토큰이 rotate 되면 auth.json 에 되써, 다음 부팅이 이미 소비된 refresh 토큰을
// 재사용하지 않게 한다.

const codexAuthPath = (): string =>
  path.join(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'auth.json');

/** access_token(JWT) 의 exp(초) → ms. 디코드 실패 시 0(=즉시 refresh 유도). */
function jwtExpiryMs(accessToken: string): number {
  try {
    const payload = accessToken.split('.')[1];
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// 만료 직전(5분)이면 미리 refresh — access token 만료 경계에서 401 나는 걸 피한다.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * pi-ai openai-codex provider 의 OAuth flow. lazyOAuth 래퍼라 첫 refresh/toAuth 호출 때
 * 구현이 동적 로드된다. 호출 시점에 provider 를 만들어야 테스트가 모듈을 mock 할 수 있다.
 */
function codexOAuth(): NonNullable<ReturnType<typeof openaiCodexProvider>['auth']['oauth']> {
  const oauth = openaiCodexProvider().auth.oauth;
  if (!oauth) throw new Error('pi-ai openai-codex provider 가 OAuth flow 를 노출하지 않는다 — pi-ai 버전 확인.');
  return oauth;
}

/** toAuth 결과에서 apiKey 를 뽑는다. openai-codex 는 access token 을 그대로 apiKey 로 쓴다. */
async function apiKeyFrom(auth: Promise<ModelAuth>): Promise<string> {
  const { apiKey } = await auth;
  if (!apiKey) throw new Error("codex OAuth 에서 apiKey 를 파생하지 못했다 — 'codex login' 후 재시도.");
  return apiKey;
}

// 마지막으로 resolve 한 키와 그 만료시각(ms). 유효하면 파일 재읽기·getOAuthApiKey
// 호출 없이 그대로 돌려준다.
let cached: { apiKey: string; expiresAt: number } | null = null;
// single-flight: 동시 호출이 각자 refresh 하면 single-use refresh token 이 레이스로
// 무효화된다. 진행 중 refresh 가 있으면 그 promise 를 공유한다.
let inFlight: Promise<string> | null = null;

function cachedKeyIfFresh(): string | null {
  if (cached && Date.now() < cached.expiresAt - REFRESH_BUFFER_MS) return cached.apiKey;
  return null;
}

async function refreshCodexApiKey(): Promise<string> {
  // lock 진입 사이에 다른 호출이 이미 갱신했을 수 있다 — 다시 확인.
  const fresh = cachedKeyIfFresh();
  if (fresh) return fresh;

  const file = codexAuthPath();
  let auth: { tokens?: { access_token?: string; refresh_token?: string } } & Record<string, unknown>;
  try {
    auth = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    throw new Error(`codex auth 파일을 읽을 수 없다 (${file}) — 'codex login' 후 재시도.`);
  }
  const access = auth.tokens?.access_token;
  const refresh = auth.tokens?.refresh_token;
  if (!access || !refresh) {
    throw new Error(`codex auth.json 에 access/refresh 토큰이 없다 — 'codex login' 후 재시도.`);
  }

  const realExpiry = jwtExpiryMs(access);
  const credential: OAuthCredential = { type: 'oauth', access, refresh, expires: realExpiry };

  // pi-ai 의 refresh 는 무조건 토큰을 교환한다 — 만료 판단은 이 모듈 몫이다. 아직 BUFFER
  // 밖이면 네트워크 없이 그대로 파생해 쓰고, decode 실패(0)면 즉시 한 번 교환을 유도한다.
  if (realExpiry && Date.now() < realExpiry - REFRESH_BUFFER_MS) {
    const apiKey = await apiKeyFrom(codexOAuth().toAuth(credential));
    cached = { apiKey, expiresAt: realExpiry };
    return apiKey;
  }

  const next = await codexOAuth().refresh(credential);
  const rotated = next.access !== access || next.refresh !== refresh;
  if (rotated) {
    auth.tokens = { ...auth.tokens, access_token: next.access, refresh_token: next.refresh };
    writeFileSync(file, JSON.stringify(auth, null, 2));
  }
  // next.expires 는 토큰 엔드포인트가 준 실제 만료(pi-ai 가 이미 5분 여유를 뺀 값).
  // 못 받으면 새 access token 의 JWT exp, 그것도 없으면 직전 realExpiry 로 폴백한다.
  const apiKey = await apiKeyFrom(codexOAuth().toAuth(next));
  cached = { apiKey, expiresAt: next.expires || jwtExpiryMs(next.access) || realExpiry };
  return apiKey;
}

// codex OAuth access token 을 resolve 한다. 유효 캐시가 있으면 그대로, 없으면
// (만료 임박 포함) refresh 한다. PiAiProvider 는 생성자에서 키를 고정하므로 호출자가
// 매 LLM 요청 전에 이걸 다시 불러야 세션 중 갱신이 반영된다.
export async function resolveCodexApiKey(): Promise<string> {
  const fresh = cachedKeyIfFresh();
  if (fresh) return fresh;
  if (inFlight) return inFlight;
  inFlight = refreshCodexApiKey().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
