/**
 * FallbackLLMProvider — 여러 LLMProvider를 순서대로 시도.
 *
 * Cancellation semantics (important):
 *   - If the caller's signal is ALREADY aborted on entry, we throw immediately
 *     without calling ANY provider.
 *   - If the caller's signal aborts mid-call, the provider's SDK will throw
 *     AbortError; we re-throw that without trying the next provider.
 *   - An empty response from a provider normally triggers fallback, BUT if the
 *     signal is aborted at that point we throw instead of returning empty —
 *     otherwise the user sees a silent "success" when they cancelled.
 */

import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMResponse,
} from '@dongkseo/contracts';
import { fallbackAls } from './fallback-als.js';

export interface FallbackProviderEntry {
  /** 사용자 표시용 이름 */
  name: string;
  /** 실제 provider */
  provider: LLMProvider;
  /**
   * 설정 시, 이 entry로 가는 모든 호출의 options.model을 이 값으로 고정한다
   * (caller가 넘긴 options.model 무시). fallback이 다른 provider로 넘어가도
   * 각 provider가 자기 모델로 호출되도록 보장한다.
   * 미설정 시 caller의 options를 그대로 통과(하위호환).
   */
  model?: string;
}

/**
 * Error classification — determines whether to retry, fallback, or abort.
 * Enables smarter handling than "any error → next provider".
 */
export type ErrorClass = 'rate-limit' | 'auth' | 'server' | 'network' | 'abort' | 'unknown';

export function classifyError(err: Error, signal?: AbortSignal): ErrorClass {
  if (isAbortError(err, signal)) return 'abort';

  const msg = err.message.toLowerCase();
  const code = (err as Error & { status?: number; statusCode?: number }).status
    ?? (err as Error & { status?: number; statusCode?: number }).statusCode;

  if (code === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
    return 'rate-limit';
  }
  if (code === 401 || code === 403 || msg.includes('unauthorized') || msg.includes('invalid api key') || msg.includes('authentication')) {
    return 'auth';
  }
  if (code !== undefined && code >= 500) return 'server';
  if (
    msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('timeout') || msg.includes('network')
    || msg.includes('econnreset') || msg.includes('terminated') || msg.includes('socket')
    || msg.includes('und_err') || msg.includes('fetch failed') || msg.includes('other side closed')
  ) {
    return 'network';
  }
  // pi-ai marks dropped-stream / SDK-parse failures as providerError (status/code lost);
  // treat them as transient so the retry loop can recover.
  if ((err as Error & { providerError?: boolean }).providerError === true) return 'network';
  return 'unknown';
}

export interface FallbackLLMProviderOptions {
  /** 우선순위 순서로 정렬된 provider 목록 */
  providers: FallbackProviderEntry[];
  /** fallback 발생 시 호출 */
  onFallback?: (from: string, to: string, reason: string) => void;
  /**
   * Optional callback when auth error occurs. Can attempt credential refresh
   * and return true if the provider should be retried with new credentials.
   * If not provided or returns false, the provider is skipped.
   */
  onAuthError?: (providerName: string) => boolean | Promise<boolean>;
  /**
   * Delay in ms before retrying after a rate-limit error.
   * Default: 1000. Set to 0 to skip retry and fallback immediately.
   */
  rateLimitRetryMs?: number;
  /**
   * Base delay in ms before retrying the SAME provider after a transient
   * connection error ('network'/'server' class, or a providerError-marked
   * dropped stream). Backoff escalates linearly per attempt. Default: 500.
   * Set to 0 to skip transient retry and fall back immediately.
   */
  transientRetryMs?: number;
  /**
   * Max same-provider retries for a transient error before falling back.
   * Default: 2. Set to 0 to disable transient retry.
   */
  transientRetryMaxAttempts?: number;
}

class AbortedBeforeCallError extends Error {
  override readonly name = 'AbortError';
  constructor() {
    super('aborted before provider call');
  }
}

export class FallbackLLMProvider implements LLMProvider {
  private readonly entries: FallbackProviderEntry[];
  private readonly onFallback?: FallbackLLMProviderOptions['onFallback'];
  private readonly onAuthError?: FallbackLLMProviderOptions['onAuthError'];
  private readonly rateLimitRetryMs: number;
  private readonly transientRetryMs: number;
  private readonly transientRetryMaxAttempts: number;

  constructor(options: FallbackLLMProviderOptions) {
    if (options.providers.length === 0) {
      throw new Error('FallbackLLMProvider requires at least one provider');
    }
    this.entries = options.providers;
    this.onFallback = options.onFallback;
    this.onAuthError = options.onAuthError;
    this.rateLimitRetryMs = options.rateLimitRetryMs ?? 1000;
    this.transientRetryMs = options.transientRetryMs ?? 500;
    this.transientRetryMaxAttempts = options.transientRetryMaxAttempts ?? 2;
  }

  /** onFallback(3인자, 불변) + fallbackAls sink 기록. err가 있으면 status 추출. */
  private emitFallback(from: string, to: string, reason: string, errorClass: string, err?: Error): void {
    this.onFallback?.(from, to, reason);
    const status = err
      ? (err as Error & { status?: number; statusCode?: number }).status
        ?? (err as Error & { status?: number; statusCode?: number }).statusCode
      : undefined;
    fallbackAls.getStore()?.record({
      from, to, errorClass,
      ...(typeof status === 'number' ? { status } : {}),
    });
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    // Pre-check: if the caller already cancelled before we even started,
    // do not waste time or tokens on ANY provider call.
    if (options?.signal?.aborted) {
      throw new AbortedBeforeCallError();
    }

    let lastError: Error | null = null;
    let retried = false;
    let transientRetries = 0;

    for (let i = 0; i < this.entries.length; i++) {
      // Re-check before each provider attempt (signal may have aborted between attempts)
      if (options?.signal?.aborted) {
        throw new AbortedBeforeCallError();
      }

      const entry = this.entries[i];
      const isLast = i === this.entries.length - 1;
      // entry.model 설정 시 이 entry 호출의 model을 고정(caller options.model 무시).
      const entryOptions = entry.model ? { ...options, model: entry.model } : options;

      // Hoisted so the catch block can tell whether ANY chunk already reached the
      // caller this attempt: a transient error after the first yield is NOT safe
      // to retry (it would duplicate already-emitted output).
      let receivedAny = false;
      try {
        for await (const chunk of entry.provider.stream(messages, entryOptions)) {
          receivedAny = true;
          yield chunk;
        }

        // If the signal was aborted during the stream, the caller has given up.
        // Emit an abort error instead of silently returning an empty success.
        if (options?.signal?.aborted) {
          throw new AbortedBeforeCallError();
        }

        // 빈 응답 → provider 장애로 간주, fallback
        if (!receivedAny && !isLast) {
          const next = this.entries[i + 1];
          this.emitFallback(entry.name, next.name, 'empty response', 'empty');
          continue;
        }
        return; // 성공
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const errorClass = classifyError(lastError, options?.signal);

        // Cancellation must NOT trigger fallback
        if (errorClass === 'abort') throw lastError;

        // Rate-limit: wait then retry same provider once before fallback
        if (errorClass === 'rate-limit' && this.rateLimitRetryMs > 0 && !retried) {
          retried = true;
          await delay(this.rateLimitRetryMs);
          i--; // retry same provider
          continue;
        }

        // Auth: attempt credential refresh before fallback
        if (errorClass === 'auth' && this.onAuthError && !retried) {
          retried = true;
          const refreshed = await this.onAuthError(entry.name);
          if (refreshed) {
            i--; // retry same provider
            continue;
          }
        }

        // Transient connection error ('network'/'server' or a providerError-marked
        // dropped stream): retry the SAME provider a bounded number of times before
        // falling back — but ONLY if no chunk has reached the caller yet. Once any
        // chunk was yielded, re-running would duplicate output, so we must fall back
        // / throw per the existing behavior instead.
        if (
          !receivedAny
          && (errorClass === 'network' || errorClass === 'server')
          && this.transientRetryMs > 0
          && transientRetries < this.transientRetryMaxAttempts
        ) {
          transientRetries++;
          await delay(this.transientRetryMs * transientRetries);
          i--; // retry same provider
          continue;
        }

        if (isLast) throw lastError;
        const next = this.entries[i + 1];
        this.emitFallback(entry.name, next.name, `[${errorClass}] ${lastError.message}`, errorClass, lastError);
        retried = false;
        transientRetries = 0;
      }
    }

    if (lastError) throw lastError;
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    if (options?.signal?.aborted) {
      throw new AbortedBeforeCallError();
    }

    let lastError: Error | null = null;
    let retried = false;
    let transientRetries = 0;

    for (let i = 0; i < this.entries.length; i++) {
      if (options?.signal?.aborted) {
        throw new AbortedBeforeCallError();
      }

      const entry = this.entries[i];
      const isLast = i === this.entries.length - 1;
      // entry.model 설정 시 이 entry 호출의 model을 고정(caller options.model 무시).
      const entryOptions = entry.model ? { ...options, model: entry.model } : options;

      try {
        const response = await entry.provider.complete(messages, entryOptions);

        if (options?.signal?.aborted) {
          throw new AbortedBeforeCallError();
        }

        // 빈 응답 → fallback
        if (
          !response.content
          && (!response.toolCalls || response.toolCalls.length === 0)
          && !isLast
        ) {
          const next = this.entries[i + 1];
          this.emitFallback(entry.name, next.name, 'empty response', 'empty');
          continue;
        }
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const errorClass = classifyError(lastError, options?.signal);

        if (errorClass === 'abort') throw lastError;

        // Rate-limit: wait then retry same provider once
        if (errorClass === 'rate-limit' && this.rateLimitRetryMs > 0 && !retried) {
          retried = true;
          await delay(this.rateLimitRetryMs);
          i--;
          continue;
        }

        // Auth: attempt credential refresh
        if (errorClass === 'auth' && this.onAuthError && !retried) {
          retried = true;
          const refreshed = await this.onAuthError(entry.name);
          if (refreshed) {
            i--;
            continue;
          }
        }

        // Transient connection error ('network'/'server' or a providerError-marked
        // dropped stream): retry the SAME provider a bounded number of times before
        // falling back. A single 'terminated'/socket blip should not kill the run,
        // and with a single provider configured there is nothing to fall back to.
        if (
          (errorClass === 'network' || errorClass === 'server')
          && this.transientRetryMs > 0
          && transientRetries < this.transientRetryMaxAttempts
        ) {
          transientRetries++;
          await delay(this.transientRetryMs * transientRetries);
          i--; // retry same provider
          continue;
        }

        if (isLast) throw lastError;
        const next = this.entries[i + 1];
        this.emitFallback(entry.name, next.name, `[${errorClass}] ${lastError.message}`, errorClass, lastError);
        retried = false;
        transientRetries = 0;
      }
    }

    throw lastError ?? new Error('All providers failed');
  }
}

/**
 * Detect cancellation: SDKs throw various flavors of AbortError, and we also
 * accept the case where the caller's signal has already been aborted (the SDK
 * may not always rebrand its rejection consistently).
 */
function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isAbortError(err: Error, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err.name === 'AbortError') return true;
  const code = (err as Error & { code?: string }).code;
  if (code === 'ABORT_ERR' || code === 'ERR_ABORTED') return true;
  return false;
}
