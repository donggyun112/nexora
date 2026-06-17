/**
 * ThinkingLlmProvider — LLMProvider wrapper that injects a default thinkingLevel.
 *
 * SDK 의 react architecture 는 LLMOptions 에 thinkingLevel 을 흘리지 않는다.
 * provider 단에서 default 를 주입해 모든 에이전트 호출 경로에 reasoning 이
 * 켜지도록 한다. options.thinkingLevel 이 명시되면 그대로 존중.
 */

import type {
  LLMChunk,
  LLMMessage,
  LLMOptions,
  LLMProvider,
  LLMResponse,
} from '@dongkseo/contracts';

export type ThinkingLevel = NonNullable<LLMOptions['thinkingLevel']>;

const VALID_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

export function parseThinkingLevel(
  raw: string | undefined,
): ThinkingLevel | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  return (VALID_LEVELS as readonly string[]).includes(v)
    ? (v as ThinkingLevel)
    : undefined;
}

// ── transient LLM-error retry ──────────────────────────────────────────────
// pi-ai 는 server 가 요청한 long retry-after 시 throw 하며 "higher-level retry
// logic" 에 위임한다(pi-ai types). react 루프엔 그게 없어 단발 throw 가 thread
// 전체를 죽인다 — wrapper 에서 transient 에러만 backoff 재시도한다.
// 분류·backoff 는 src/tools/http.ts 컨벤션을 미러 (fetch 전용이라 직접 호출 불가).
// 529 = Anthropic "Overloaded" (가장 흔한 transient). status 가 authoritative 라
// 여기 없으면 message 정규식에 있어도 도달 못 하므로 명시 포함.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRYABLE_NET_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED',
]);
const TRANSIENT_MSG_RE =
  /rate.?limit|overload|529|too many requests|timeout|temporarily unavailable/i;

const LLM_MAX_RETRIES = (() => {
  const n = Number.parseInt(process.env.LLM_MAX_RETRIES ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
})();
const LLM_RETRY_BASE_MS = (() => {
  const n = Number.parseInt(process.env.LLM_RETRY_BASE_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
})();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errStatus(err: unknown): number | undefined {
  const s =
    (err as { status?: unknown }).status ??
    (err as { cause?: { status?: unknown } }).cause?.status;
  return typeof s === 'number' ? s : undefined;
}

function retryAfterSeconds(err: unknown): string | null {
  const h = (err as { headers?: unknown }).headers;
  if (!h) return null;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get('retry-after');
  if (typeof h === 'object') {
    const v = (h as Record<string, unknown>)['retry-after'];
    return typeof v === 'string' ? v : null;
  }
  return null;
}

// status 가 있으면 그게 authoritative — non-transient(400/401/403/404/422 등)은
// 재시도하지 않는다(context-overflow·auth·invalid request 는 재시도 무의미).
function isTransientLlmError(err: unknown): boolean {
  if (err == null) return false;
  // pi-ai surfaces upstream failures (overload, dropped stream, SDK parse error)
  // as stopReason='error' with the status dropped — mapping.ts marks them so we
  // retry here instead of killing the agent run on a transient blip.
  if ((err as { providerError?: boolean }).providerError === true) return true;
  const status = errStatus(err);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  const code =
    (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
  if (code && RETRYABLE_NET_CODES.has(code)) return true;
  if ((err as { name?: string }).name === 'TimeoutError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_MSG_RE.test(msg);
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const s = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 30_000);
  }
  const base = LLM_RETRY_BASE_MS * 2 ** attempt;
  return base + Math.random() * base * 0.5; // +0~50% jitter
}

export class ThinkingLlmProvider implements LLMProvider {
  constructor(
    private readonly inner: LLMProvider,
    private readonly defaultLevel: ThinkingLevel,
  ) {}

  // react 루프는 complete() 만 쓴다 — stream() 은 retry 범위 외.
  stream(
    messages: LLMMessage[],
    options?: LLMOptions,
  ): AsyncGenerator<LLMChunk> {
    return this.inner.stream(messages, this.withLevel(options));
  }

  async complete(
    messages: LLMMessage[],
    options?: LLMOptions,
  ): Promise<LLMResponse> {
    const merged = this.withLevel(options);
    let attempt = 0;
    for (;;) {
      try {
        return await this.inner.complete(messages, merged);
      } catch (err) {
        if (merged.signal?.aborted) throw err; // 호출자 취소 → 재시도 안 함
        if (attempt < LLM_MAX_RETRIES && isTransientLlmError(err)) {
          await sleep(backoffMs(attempt, retryAfterSeconds(err)));
          attempt += 1;
          continue;
        }
        // 재시도까지 소진한 terminal LLM 실패 — react 가 이 예외를 error 이벤트로
        // 삼켜 stack 이 사라지므로, 끝내기 직전 stack 과 메시지 구조를 한 번 남긴다.
        console.error('[llm] call failed (terminal, after retries)', {
          err: err instanceof Error ? err.stack ?? err.message : String(err),
          messages: messages.map((m) => ({
            role: m.role,
            contentType: typeof m.content,
            isArray: Array.isArray(m.content),
            preview:
              typeof m.content === 'string'
                ? m.content.slice(0, 80)
                : JSON.stringify(m.content).slice(0, 200),
          })),
        });
        throw err;
      }
    }
  }

  private withLevel(options?: LLMOptions): LLMOptions {
    if (options?.thinkingLevel) return options;
    return { ...(options ?? {}), thinkingLevel: this.defaultLevel };
  }
}
