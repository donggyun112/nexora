/**
 * FallbackLLMProvider — 여러 LLMProvider를 순서대로 시도.
 *
 * 한쪽 API가 만료/장애 시 다음 provider로 자동 전환.
 * 참고: provider-fallback.ts
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
    let lastError: Error | null = null;

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const isLast = i === this.entries.length - 1;

      try {
        let receivedAny = false;
        for await (const chunk of entry.provider.stream(messages, options)) {
          receivedAny = true;
          yield chunk;
        }

        // 빈 응답 → provider 장애로 간주, fallback (단 abort된 상태면 중단)
        if (!receivedAny && !isLast && !options?.signal?.aborted) {
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
    let lastError: Error | null = null;

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const isLast = i === this.entries.length - 1;

      try {
        const response = await entry.provider.complete(messages, options);
        // 빈 응답 → fallback (단 abort된 상태면 중단)
        if (
          !response.content
          && (!response.toolCalls || response.toolCalls.length === 0)
          && !isLast
          && !options?.signal?.aborted
        ) {
          const next = this.entries[i + 1];
          this.onFallback?.(entry.name, next.name, 'empty response');
          continue;
        }
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Cancellation must NOT trigger fallback.
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
  // Some SDKs use DOMException with name='AbortError'
  const code = (err as Error & { code?: string }).code;
  if (code === 'ABORT_ERR' || code === 'ERR_ABORTED') return true;
  return false;
}
