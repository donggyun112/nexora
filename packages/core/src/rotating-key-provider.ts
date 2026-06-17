/**
 * RotatingKeyProvider — LLMProvider wrapper for providers whose API key expires.
 *
 * PiAiProvider 는 apiKey 를 생성자에서 고정한다. codex 구독 OAuth access token 은
 * 만료돼 refresh token 으로 rotate 되므로, 부팅 때 한 번 resolve 한 키로 굳히면
 * 만료 후 모든 호출이 stale 키로 401 난다. 이 wrapper 는 매 호출 전에 키를
 * re-resolve 하고(resolveKey 가 자체 캐시·refresh 담당), 키가 바뀐 경우에만 inner
 * provider 를 재생성한다.
 */

import type {
  LLMChunk,
  LLMMessage,
  LLMOptions,
  LLMProvider,
  LLMResponse,
} from '@dongkseo/contracts';

export class RotatingKeyProvider implements LLMProvider {
  private cachedKey?: string;
  private inner?: LLMProvider;

  constructor(
    private readonly resolveKey: () => Promise<string>,
    private readonly build: (apiKey: string) => LLMProvider,
  ) {}

  private async current(): Promise<LLMProvider> {
    const key = await this.resolveKey();
    if (!this.inner || key !== this.cachedKey) {
      this.cachedKey = key;
      this.inner = this.build(key);
    }
    return this.inner;
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    yield* (await this.current()).stream(messages, options);
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    return (await this.current()).complete(messages, options);
  }
}
