import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getOAuthApiKey } from '@earendil-works/pi-ai/oauth';

// Claude(Anthropic) 구독 OAuth 로 anthropic provider 를 인증한다 — codex-auth 와 대칭.
// 토큰은 ~8h 만료. PiAiProvider 는 apiKey 를 생성자에서 고정하므로, 부팅 때 한 번 resolve 한
// 토큰으로 굳히면 만료 후 모든 호출이 stale 토큰으로 401 난다. 호출자(RotatingKeyProvider)가
// 매 요청 전에 이걸 다시 부르고, 이 resolver 는 라이브 소스(keychain/credentials.json)를 읽어
// 외부 Claude Code 의 갱신을 그대로 집어온다. 소스 토큰이 만료(임박)면 refresh_token 으로
// getOAuthApiKey 가 직접 재발급하고 rotate 된 토큰을 소스에 되쓴다.

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

export interface AnthropicKeyResolverDeps {
  readSource: () => AnthropicOAuthSource | null;
  refreshOAuth: typeof getOAuthApiKey;
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

const REAL_DEPS: AnthropicKeyResolverDeps = {
  readSource: readAnthropicSource,
  refreshOAuth: getOAuthApiKey,
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

    // pi-ai 의 getOAuthApiKey 는 Date.now() >= expires 일 때만 refresh 한다(자체 버퍼 없음).
    // 실제 만료를 BUFFER 만큼 앞당겨 넘겨, 경계 전에 선제 교체되게 한다.
    const result = await deps.refreshOAuth('anthropic', {
      anthropic: {
        access: source.access,
        refresh: source.refresh,
        expires: source.expires ? source.expires - REFRESH_BUFFER_MS : 0,
      },
    });
    if (!result) throw new Error("anthropic OAuth 토큰 resolve 실패 — 'claude' 로그인 후 재시도.");

    const next = result.newCredentials;
    const rotated = !!next && (next.access !== source.access || next.refresh !== source.refresh);
    if (rotated && next.refresh) {
      deps.writeBack(source, { access: next.access, refresh: next.refresh, expires: next.expires || source.expires });
    }

    // rotate 됐으면 next.expires 가 토큰 엔드포인트가 준 실제 새 만료. 안 됐으면 getOAuthApiKey 는
    // 입력 creds 를 echo 하므로 우리가 넣은 (줄인) 값이라 신뢰하지 말고 source.expires 를 캐싱한다.
    cached = { apiKey: result.apiKey, expiresAt: rotated ? next.expires || source.expires : source.expires };
    return result.apiKey;
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
