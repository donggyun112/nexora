import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLMProvider, LLMMessage, LLMOptions, LLMChunk, LLMResponse } from '@dongkseo/contracts';

/** 한 번의 provider→provider 전환에 대한 사실. */
export interface FallbackRecord {
  /** 떠난 pole 이름 (provider/model). */
  from: string;
  /** 넘어간 pole 이름 (provider/model). */
  to: string;
  /** classifyError 결과 문자열, 또는 empty-response 시 'empty'. */
  errorClass: string;
  /** HTTP status (err.status ?? err.statusCode) 있으면. */
  status?: number;
}

/** 현재 턴의 fallback 기록 대상. execution-harness가 recorder에 바인딩해 주입한다. */
export interface FallbackSink {
  record(rec: FallbackRecord): void;
}

/** LLM 호출 구간 동안 활성화되는 per-turn fallback sink. */
export const fallbackAls = new AsyncLocalStorage<FallbackSink>();

/**
 * llm의 stream/complete 호출을 fallbackAls 컨텍스트로 감싼다.
 *
 * complete: run() 내부에서 동기적으로 호출돼 await 체인이 store를 상속.
 * stream: 제너레이터 body는 첫 .next()에서야 실행되므로, run()으로 제너레이터
 *   생성만 감싸면 store가 안 잡힌다. 매 .next()를 run()으로 감싸야 각 스텝
 *   (특히 fallback이 발생하는 catch 블록)이 store를 본다.
 */
export function bindFallbackContext(llm: LLMProvider, sink?: FallbackSink): LLMProvider {
  if (!sink) return llm;
  return {
    async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
      const gen = llm.stream(messages, options);
      while (true) {
        const step = await fallbackAls.run(sink, () => gen.next());
        if (step.done) return;
        yield step.value;
      }
    },
    complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
      return fallbackAls.run(sink, () => llm.complete(messages, options));
    },
  };
}
