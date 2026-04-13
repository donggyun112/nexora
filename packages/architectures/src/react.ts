/**
 * ReAct Architecture — Reasoning + Acting 루프.
 *
 * 표준 ReAct 패턴:
 *   1. LLM 호출 (system + history + user)
 *   2. 응답에 도구 호출 있으면:
 *      - 모든 도구 병렬 실행
 *      - 결과를 history에 추가
 *      - 다시 LLM 호출
 *   3. 응답에 도구 호출 없으면 종료
 *
 * 참고: reference runner.ts streamAgent() 내부 루프
 */

import type {
  AgentArchitecture,
  AgentEvent,
  AgentInput,
  RuntimeServices,
  LLMMessage,
  LLMContentBlock,
  LLMResponse,
} from '@nexora/contracts';

export interface ReactOptions {
  /** 시스템 프롬프트 */
  systemPrompt?: string;
  /** 최대 반복 횟수 (도구 호출 라운드, 기본 25) */
  maxIterations?: number;
  /** LLM 옵션 */
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

const DEFAULT_MAX_ITERATIONS = 25;

export function createReactArchitecture(options: ReactOptions = {}): AgentArchitecture {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  return {
    name: 'react',

    async *loop(services: RuntimeServices, input: AgentInput): AsyncGenerator<AgentEvent> {
      const history: LLMMessage[] = [];

      // 1. 이전 대화 히스토리
      const memoryHistory = await services.memory.getHistory();
      for (const msg of memoryHistory) {
        history.push({ role: msg.role, content: msg.content });
      }
      for (const prev of input.history ?? []) {
        history.push({ role: prev.role, content: prev.content });
      }

      // 2. 현재 사용자 입력
      const userContent = input.images && input.images.length > 0
        ? [
            { type: 'text' as const, text: input.prompt },
            ...input.images.map(img => ({
              type: 'image' as const,
              data: img.data,
              mimeType: img.mimeType,
            })),
          ]
        : input.prompt;
      history.push({ role: 'user', content: userContent });
      await services.memory.append({ role: 'user', content: input.prompt });

      const allToolCalls: { name: string; input: unknown }[] = [];
      let lastContent = '';

      // 3. ReAct 루프
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (services.signal.aborted) return;

        let response: LLMResponse;
        try {
          response = await services.llm.complete(history, {
            systemPrompt: options.systemPrompt,
            model: options.model,
            maxTokens: options.maxTokens,
            temperature: options.temperature,
            signal: services.signal,
          });
        } catch (err) {
          if (services.signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          yield { type: 'error', message };
          return;
        }

        lastContent = response.content;

        // 텍스트 응답
        if (response.content) {
          yield { type: 'text', text: response.content };
        }

        // 도구 호출이 없으면 종료
        if (!response.toolCalls || response.toolCalls.length === 0) {
          await services.memory.append({ role: 'assistant', content: response.content });
          yield {
            type: 'done',
            content: response.content,
            toolCalls: allToolCalls,
          };
          return;
        }

        // assistant 메시지 (텍스트 + tool_call) history에 추가
        history.push({
          role: 'assistant',
          content: [
            ...(response.content ? [{ type: 'text' as const, text: response.content }] : []),
            ...response.toolCalls.map(tc => ({
              type: 'tool_call' as const,
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
          ],
        });

        // tool_call 이벤트는 실행 시작 전에 emit
        for (const tc of response.toolCalls) {
          allToolCalls.push({ name: tc.name, input: tc.arguments });
          yield { type: 'tool_call', id: tc.id, name: tc.name, input: tc.arguments };
        }

        // 도구 병렬 실행 (Promise.all 안에서 yield 불가하므로 결과 모은 후 일괄 emit)
        const toolResults = await Promise.all(
          response.toolCalls.map(async (tc) => {
            const result = await services.tools.execute(tc.name, tc.id, tc.arguments, services.signal);
            return { tc, result };
          }),
        );

        if (services.signal.aborted) return;

        // tool_result emit + history에 추가할 블록 생성
        const toolResultBlocks: { type: 'tool_result'; id: string; content: string; isError: boolean }[] = [];
        for (const { tc, result } of toolResults) {
          const isError = isErrorResult(result);
          yield { type: 'tool_result', id: tc.id, name: tc.name, result, isError };

          toolResultBlocks.push({
            type: 'tool_result',
            id: tc.id,
            content: formatResultForLLM(result),
            isError,
          });
        }

        // tool_result 메시지 history에 추가
        history.push({
          role: 'tool_result',
          content: toolResultBlocks,
        });

        // 컴팩션 시도 + tool pair sanitization
        await services.memory.compact();
        sanitizeToolPairsInPlace(history);
      }

      // max iterations 도달
      yield {
        type: 'done',
        content: lastContent || '(max iterations reached)',
        toolCalls: allToolCalls,
      };
    },
  };
}

/**
 * Sanitize tool_call/tool_result pairs in-place after compaction.
 * Ensures every tool_call has a matching tool_result (prevents API crashes).
 */
function sanitizeToolPairsInPlace(history: LLMMessage[]): void {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const msg of history) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as LLMContentBlock[]) {
        if (block.type === 'tool_call') callIds.add(block.id);
      }
    }
    if (msg.role === 'tool_result' && Array.isArray(msg.content)) {
      for (const block of msg.content as LLMContentBlock[]) {
        if (block.type === 'tool_result') resultIds.add(block.id);
      }
    }
  }

  // Remove orphaned tool_result messages (results without matching calls)
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'tool_result' || !Array.isArray(msg.content)) continue;
    const blocks = (msg.content as LLMContentBlock[]).filter(
      b => b.type === 'tool_result',
    );
    if (blocks.length > 0 && !blocks.some(b => b.type === 'tool_result' && callIds.has(b.id))) {
      history.splice(i, 1);
    }
  }

  // Insert stub results for orphaned calls
  const orphanedIds = [...callIds].filter(id => !resultIds.has(id));
  if (orphanedIds.length > 0) {
    history.push({
      role: 'tool_result',
      content: orphanedIds.map(id => ({
        type: 'tool_result' as const,
        id,
        content: '[result lost during context compaction]',
        isError: false,
      })),
    });
  }
}

function isErrorResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  return (result as { type?: string }).type === 'error';
}

function formatResultForLLM(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result);
  const r = result as { type?: string; text?: string; message?: string };
  if (r.type === 'text' && typeof r.text === 'string') return r.text;
  if (r.type === 'error' && typeof r.message === 'string') return `[ERROR] ${r.message}`;
  if (r.type === 'image') return '[image]';
  return JSON.stringify(result);
}
