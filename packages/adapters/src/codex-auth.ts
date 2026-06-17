import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getOAuthApiKey } from '@earendil-works/pi-ai/oauth';

// ChatGPT/Codex 구독 OAuth 로 openai-codex provider 를 인증한다 (Agent-workflow 레퍼런스와 동일
// 전략). restricted OpenAI 플랫폼 API 키는 gpt-5.x-codex 의 Responses API(api.responses.write)
// 스코프가 없어 401 이 난다 — 구독 OAuth 토큰은 그 제약을 받지 않는다.
//
// `codex login` 이 ~/.codex/auth.json 에 access/refresh 토큰을 저장한다. pi-ai 의
// getOAuthApiKey 가 만료를 보고 필요하면 refresh 까지 해준다. refresh 로 토큰이 rotate 되면
// auth.json 에 되써, 다음 부팅이 이미 소비된 refresh 토큰을 재사용하지 않게 한다.

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

  // pi-ai 의 getOAuthApiKey 는 Date.now() >= expires 일 때만 refresh 한다(자체 버퍼
  // 없음). 실제 만료를 BUFFER 만큼 앞당겨 넘겨, 경계 전에 선제 교체되게 한다. decode
  // 실패(0)면 0 을 넘겨 즉시 한 번 refresh 를 유도한다.
  const realExpiry = jwtExpiryMs(access);
  const result = await getOAuthApiKey('openai-codex', {
    'openai-codex': { access, refresh, expires: realExpiry ? realExpiry - REFRESH_BUFFER_MS : 0 },
  });
  if (!result) {
    throw new Error(`codex OAuth 토큰 resolve 실패 — 'codex login' 후 재시도.`);
  }

  const next = result.newCredentials;
  const rotated = !!next && (next.access !== access || next.refresh !== refresh);
  if (rotated) {
    auth.tokens = { ...auth.tokens, access_token: next.access, refresh_token: next.refresh };
    writeFileSync(file, JSON.stringify(auth, null, 2));
  }
  // refresh 됐으면 next.expires 가 토큰 엔드포인트가 준 실제 새 만료다. refresh 안 됐으면
  // getOAuthApiKey 는 입력 creds 를 그대로 echo 하므로 next.expires 는 우리가 넣은 (줄인)
  // 값 — 신뢰하지 말고 realExpiry 를 캐싱한다(이중 차감 방지).
  const expiresAt = rotated ? (next.expires || jwtExpiryMs(next.access)) : realExpiry;
  cached = { apiKey: result.apiKey, expiresAt };
  return result.apiKey;
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
