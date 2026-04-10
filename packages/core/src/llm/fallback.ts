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
} from '@nexora/contracts';

export interface FallbackProviderEntry {
  /** 사용자 표시용 이름 */
  name: string;
  /** 실제 provider */
  provider: LLMProvider;
}

export interface FallbackLLMProviderOptions {
  /** 우선순위 순서로 정렬된 provider 목록 */
  providers: FallbackProviderEntry[];
  /** fallback 발생 시 호출 */
  onFallback?: (from: string, to: string, reason: string) => void;
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

  constructor(options: FallbackLLMProviderOptions) {
    if (options.providers.length === 0) {
      throw new Error('FallbackLLMProvider requires at least one provider');
    }
    this.entries = options.providers;
    this.onFallback = options.onFallback;
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    // Pre-check: if the caller already cancelled before we even started,
    // do not waste time or tokens on ANY provider call.
    if (options?.signal?.aborted) {
      throw new AbortedBeforeCallError();
    }

    let lastError: Error | null = null;

    for (let i = 0; i < this.entries.length; i++) {
      // Re-check before each provider attempt (signal may have aborted between attempts)
      if (options?.signal?.aborted) {
        throw new AbortedBeforeCallError();
      }

      const entry = this.entries[i];
      const isLast = i === this.entries.length - 1;

      try {
        let receivedAny = false;
        for await (const chunk of entry.provider.stream(messages, options)) {
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
          this.onFallback?.(entry.name, next.name, 'empty response');
          continue;
        }
        return; // 성공
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Cancellation must NOT trigger fallback — the caller intentionally aborted.
        // Trying the next provider would just re-fail (or worse, do work the user gave up on).
        if (isAbortError(lastError, options?.signal)) throw lastError;
        if (isLast) throw lastError;
        const next = this.entries[i + 1];
        this.onFallback?.(entry.name, next.name, lastError.message);
      }
    }

    if (lastError) throw lastError;
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    if (options?.signal?.aborted) {
      throw new AbortedBeforeCallError();
    }

    let lastError: Error | null = null;

    for (let i = 0; i < this.entries.length; i++) {
      if (options?.signal?.aborted) {
        throw new AbortedBeforeCallError();
      }

      const entry = this.entries[i];
      const isLast = i === this.entries.length - 1;

      try {
        const response = await entry.provider.complete(messages, options);

        // If the signal aborted during the call, throw instead of returning
        // what may be a partial/empty response.
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
          this.onFallback?.(entry.name, next.name, 'empty response');
          continue;
        }
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isAbortError(lastError, options?.signal)) throw lastError;
        if (isLast) throw lastError;
        const next = this.entries[i + 1];
        this.onFallback?.(entry.name, next.name, lastError.message);
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
function isAbortError(err: Error, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err.name === 'AbortError') return true;
  const code = (err as Error & { code?: string }).code;
  if (code === 'ABORT_ERR' || code === 'ERR_ABORTED') return true;
  return false;
}
