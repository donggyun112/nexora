/**
 * Loop Architecture — 조건 만족까지 반복.
 *
 * 사용처: 배치 작업, 폴링, 반복 실행 패턴.
 * 단일 도구/단일 LLM 호출을 조건이 참이 될 때까지 반복.
 */

import type {
  AgentArchitecture,
  AgentEvent,
  AgentInput,
  RuntimeServices,
} from '@nexora/contracts';

export interface LoopOptions {
  /** 시스템 프롬프트 */
  systemPrompt?: string;
  /** 최대 반복 횟수 */
  maxIterations?: number;
  /** 종료 조건 — 반환값이 true면 중단 */
  shouldStop: (iteration: number, lastContent: string) => boolean | Promise<boolean>;
  /** 매 반복 사이 지연 (ms) */
  delayMs?: number;
  /** LLM 옵션 */
  model?: string;
}

export function createLoopArchitecture(options: LoopOptions): AgentArchitecture {
  const maxIterations = options.maxIterations ?? 100;

  return {
    name: 'loop',

    async *loop(services: RuntimeServices, input: AgentInput): AsyncGenerator<AgentEvent> {
      let lastContent = '';

      for (let i = 0; i < maxIterations; i++) {
        if (services.signal.aborted) return;
        yield { type: 'progress', message: `iteration ${i + 1}/${maxIterations}` };

        try {
          const response = await services.llm.complete(
            [{ role: 'user', content: `${input.prompt}\n\n[iteration ${i + 1}]` }],
            { systemPrompt: options.systemPrompt, model: options.model, signal: services.signal },
          );
          lastContent = response.content;
          if (response.content) yield { type: 'text', text: response.content };
        } catch (err) {
          if (services.signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          yield { type: 'error', message };
          return;
        }

        const stop = await options.shouldStop(i, lastContent);
        if (stop) break;

        if (options.delayMs && options.delayMs > 0) {
          // Abortable sleep — must NOT keep ticking after the user aborts
          // (a long delayMs would otherwise stretch the agent's effective lifetime).
          try {
            await abortableSleep(options.delayMs, services.signal);
          } catch {
            return; // signal aborted during the wait
          }
        }
      }

      yield { type: 'done', content: lastContent, toolCalls: [] };
    },
  };
}

/**
 * Sleep that resolves after `ms` ms or rejects immediately if the signal aborts.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
