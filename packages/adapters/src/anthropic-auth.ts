import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import type { ModelAuth, OAuthCredential } from '@earendil-works/pi-ai';

// Claude(Anthropic) 구독 OAuth 로 anthropic provider 를 인증한다 — codex-auth 와 대칭.
// 토큰은 ~8h 만료. PiAiProvider 는 apiKey 를 생성자에서 고정하므로, 부팅 때 한 번 resolve 한
// 토큰으로 굳히면 만료 후 모든 호출이 stale 토큰으로 401 난다. 호출자(RotatingKeyProvider)가
// 매 요청 전에 이걸 다시 부르고, 이 resolver 는 라이브 소스(keychain/credentials.json)를 읽어
// 외부 Claude Code 의 갱신을 그대로 집어온다. 소스 토큰이 만료(임박)면 refresh_token 으로
// pi-ai OAuth flow 가 직접 재발급하고 rotate 된 토큰을 소스에 되쓴다.

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

interface OAuthBlob {
  access: string;
  refresh?: string;
  expires: number; // ms epoch
}

export interface AnthropicOAuthSource extends OAuthBlob {
  origin: 'keychain' | 'file';
  account?: string; // keychain account — write-back 대상 식별
  file?: string;
}

/**
 * pi-ai OAuth 표면 중 이 모듈이 쓰는 최소 포트. pi-ai 0.80.10 이 `getOAuthApiKey` 를 없애고
 * refresh(토큰 교환)/toAuth(요청 auth 파생) 로 쪼갰다 — "만료면 refresh" 판단이 라이브러리
 * 내부에서 호출자로 넘어왔으므로, 아래 resolver 가 버퍼를 보고 직접 결정한다.
 */
export interface OAuthPort {
  /** refresh_token 교환. 네트워크 호출이며 실패 시 throw(invalid_grant 등). */
  refresh: (credential: OAuthCredential) => Promise<OAuthCredential>;
  /** credential → 요청 auth 파생. 부수효과 없음. */
  toAuth: (credential: OAuthCredential) => Promise<ModelAuth>;
}

export interface AnthropicKeyResolverDeps {
  readSource: () => AnthropicOAuthSource | null;
  oauth: OAuthPort;
  writeBack: (source: AnthropicOAuthSource, blob: OAuthBlob) => void;
  staticApiKey: () => string | undefined;
  envOAuthToken: () => string | undefined;
  now: () => number;
}

export function parseBlob(raw: string): OAuthBlob | null {
  let json: { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number } };
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = json?.claudeAiOauth;
  if (!o?.accessToken) return null;
  return {
    access: o.accessToken,
    refresh: o.refreshToken,
    expires: typeof o.expiresAt === 'number' ? o.expiresAt : 0,
  };
}

function credentialsFile(): string {
  return process.env.ANTHROPIC_CREDENTIALS_FILE ?? path.join(homedir(), '.claude', '.credentials.json');
}

function readFromKeychain(): AnthropicOAuthSource | null {
  if (process.platform !== 'darwin') return null;
  let raw: string;
  try {
    raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
  const blob = parseBlob(raw);
  if (!blob) return null;
  // account 는 write-back(security add-generic-password -a)에만 필요 — 못 구해도 read 는 유효.
  let account: string | undefined;
  try {
    const meta = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-g'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    account = meta.match(/"acct"<blob>="([^"]*)"/)?.[1];
  } catch {
    // best-effort
  }
  return { ...blob, origin: 'keychain', account };
}

function readFromFile(): AnthropicOAuthSource | null {
  const file = credentialsFile();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const blob = parseBlob(raw);
  if (!blob) return null;
  return { ...blob, origin: 'file', file };
}

// macOS 는 keychain 이 정본(파일 부재가 정상), 컨테이너는 마운트된 credentials.json 이 정본.
function readAnthropicSource(): AnthropicOAuthSource | null {
  return readFromKeychain() ?? readFromFile();
}

// 소스는 Claude Code 앱과 공유(co-owned)된다. write-back 직전 현재 저장값보다 우리 토큰이
// 실제로 더 새(늦은 expiresAt)일 때만 덮는다 — read-modify-write 레이스로 앱이 방금 회전시킨
// 더 신선한 토큰을 클로버하지 않게 한다.
export function shouldOverwriteStoredToken(currentExpiry: number, nextExpiry: number): boolean {
  return nextExpiry > currentExpiry;
}

// rotate 된 토큰을 소스에 되써, 다음 부팅이 이미 소비된(single-use) refresh 토큰을 재사용하지
// 않게 한다. 다른 필드(scopes 등)는 보존. 소스가 Claude Code 앱과 공유되므로 expiry 가드로
// 더 새 토큰을 덮지 않는다. 실패해도 세션은 메모리 캐시로 계속되므로 best-effort.
function writeBackToSource(source: AnthropicOAuthSource, blob: OAuthBlob): void {
  try {
    if (source.origin === 'file' && source.file) {
      let existing: { claudeAiOauth?: Record<string, unknown> } & Record<string, unknown> = {};
      try {
        existing = JSON.parse(readFileSync(source.file, 'utf-8'));
      } catch {
        // 신규 파일
      }
      const cur = existing.claudeAiOauth;
      const curExpiry = typeof cur?.expiresAt === 'number' ? (cur.expiresAt as number) : 0;
      if (!shouldOverwriteStoredToken(curExpiry, blob.expires)) return;
      existing.claudeAiOauth = {
        ...(cur ?? {}),
        accessToken: blob.access,
        refreshToken: blob.refresh,
        expiresAt: blob.expires,
      };
      writeFileSync(source.file, JSON.stringify(existing, null, 2), { mode: 0o600 });
      return;
    }
    if (source.origin === 'keychain' && source.account && process.platform === 'darwin') {
      let cur: Record<string, unknown> = {};
      try {
        const raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
          .toString()
          .trim();
        cur = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth ?? {};
      } catch {
        // 현재 blob 못 읽으면 빈 cur — 아래 가드에서 expiry 0 으로 취급
      }
      const curExpiry = typeof cur.expiresAt === 'number' ? (cur.expiresAt as number) : 0;
      if (!shouldOverwriteStoredToken(curExpiry, blob.expires)) return;
      const merged = { ...cur, accessToken: blob.access, refreshToken: blob.refresh, expiresAt: blob.expires };
      execFileSync(
        'security',
        ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', source.account, '-w', JSON.stringify({ claudeAiOauth: merged })],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
    }
  } catch {
    console.error(`[anthropic-auth] 토큰 write-back 실패 (${source.origin}) — 세션은 메모리 캐시로 계속.`);
  }
}

/**
 * 실제 포트 — pi-ai anthropic provider 가 노출하는 OAuth flow 로 위임한다. flow 는
 * lazyOAuth 래퍼라 첫 refresh/toAuth 호출 때 구현이 동적 로드된다(모듈 로드 시 비용 없음).
 */
function piAnthropicOAuthPort(): OAuthPort {
  const flow = () => {
    const oauth = anthropicProvider().auth.oauth;
    if (!oauth) throw new Error('pi-ai anthropic provider 가 OAuth flow 를 노출하지 않는다 — pi-ai 버전 확인.');
    return oauth;
  };
  return {
    refresh: credential => flow().refresh(credential),
    toAuth: credential => flow().toAuth(credential),
  };
}

/** toAuth 결과에서 apiKey 를 뽑는다. anthropic 은 access token 을 그대로 apiKey 로 쓴다. */
async function apiKeyFrom(auth: Promise<ModelAuth>): Promise<string> {
  const { apiKey } = await auth;
  if (!apiKey) throw new Error('anthropic OAuth 에서 apiKey 를 파생하지 못했다 — pi-ai toAuth 응답에 apiKey 없음.');
  return apiKey;
}

const REAL_DEPS: AnthropicKeyResolverDeps = {
  readSource: readAnthropicSource,
  oauth: piAnthropicOAuthPort(),
  writeBack: writeBackToSource,
  staticApiKey: () => process.env.ANTHROPIC_API_KEY,
  envOAuthToken: () => process.env.ANTHROPIC_OAUTH_TOKEN,
  now: () => Date.now(),
};

// factory — 모듈 캐시/single-flight 상태를 인스턴스에 가둬 테스트가 격리된 상태로 검증한다.
export function createAnthropicKeyResolver(deps: AnthropicKeyResolverDeps = REAL_DEPS): () => Promise<string> {
  let cached: { apiKey: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  const cachedIfFresh = (): string | null => {
    if (cached && deps.now() < cached.expiresAt - REFRESH_BUFFER_MS) return cached.apiKey;
    return null;
  };

  const refresh = async (): Promise<string> => {
    // lock 진입 사이에 다른 호출이 이미 갱신했을 수 있다 — 다시 확인.
    const warm = cachedIfFresh();
    if (warm) return warm;

    // 정적 API 키(sk-ant…)는 OAuth 가 아니라 만료/회전이 없다 — 그대로 고정.
    const staticKey = deps.staticApiKey();
    if (staticKey) {
      cached = { apiKey: staticKey, expiresAt: Number.MAX_SAFE_INTEGER };
      return staticKey;
    }

    const source = deps.readSource();
    if (!source) {
      // 마지막 폴백: sync-auth 가 .env 에 떠둔 OAuth 토큰. refresh 불가(정적)이고 곧 만료될 수
      // 있으나, 소스가 전혀 없을 때의 floor 로만 둔다.
      const envTok = deps.envOAuthToken();
      if (envTok) return envTok;
      throw new Error("anthropic OAuth 자격증명을 찾을 수 없다 — 'claude' 로그인 후 재시도.");
    }

    // refresh_token 이 없으면(access 만 있는 비정상) 회전 불가 — access 그대로 쓴다.
    if (!source.refresh) {
      cached = { apiKey: source.access, expiresAt: source.expires };
      return source.access;
    }

    const credential: OAuthCredential = {
      type: 'oauth',
      access: source.access,
      refresh: source.refresh,
      expires: source.expires,
    };

    // pi-ai 의 refresh 는 무조건 토큰을 교환한다 — 만료 판단은 우리 몫이다. 소스 토큰이
    // 아직 BUFFER 밖이면 네트워크 없이 그대로 파생해 쓴다(외부 Claude Code 가 갱신한
    // 토큰을 집어오는 경로). expires 가 0(=불명)이면 즉시 교환을 유도한다.
    if (source.expires && deps.now() < source.expires - REFRESH_BUFFER_MS) {
      const apiKey = await apiKeyFrom(deps.oauth.toAuth(credential));
      cached = { apiKey, expiresAt: source.expires };
      return apiKey;
    }

    const next = await deps.oauth.refresh(credential);
    const rotated = next.access !== source.access || next.refresh !== source.refresh;
    if (rotated && next.refresh) {
      deps.writeBack(source, { access: next.access, refresh: next.refresh, expires: next.expires || source.expires });
    }

    // next.expires 는 토큰 엔드포인트가 준 실제 만료(pi-ai 가 이미 5분 여유를 뺀 값).
    // cachedIfFresh 가 BUFFER 를 한 번 더 빼므로 실제로는 만료 10분 전에 선제 교체된다.
    const apiKey = await apiKeyFrom(deps.oauth.toAuth(next));
    cached = { apiKey, expiresAt: next.expires || source.expires };
    return apiKey;
  };

  return async function resolveAnthropicApiKey(): Promise<string> {
    const warm = cachedIfFresh();
    if (warm) return warm;
    if (inFlight) return inFlight;
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

// codex 와 대칭의 모듈 싱글톤 — 매 LLM 요청 전 RotatingKeyProvider 가 호출한다.
export const resolveAnthropicApiKey = createAnthropicKeyResolver();
