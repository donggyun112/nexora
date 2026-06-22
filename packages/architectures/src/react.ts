/**
 * ReAct Architecture — Reasoning + Acting 루프.
 *
 * 표준 ReAct 패턴:
 *   1. LLM 호출 (system + history + user)
 *   2. 응답에 도구 호출 있으면:
 *      - executor 정책에 따라 도구 실행
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
  LLMResponse,
} from '@dongkseo/contracts';
import {
  executeToolCalls,
  formatResultForLLM,
  imageResultForLLM,
  isErrorResult,
  pruneLoopHistory,
  sanitizeToolPairsInPlace,
  userContentForInput,
  type LoopCompactionOptions,
} from './loop-helpers.js';
import { streamLlm } from './stream-llm.js';

export interface ReactOptions {
  /** 시스템 프롬프트 */
  systemPrompt?: string;
  /** 최대 반복 횟수 (도구 호출 라운드, 기본 25) */
  maxIterations?: number;
  /** LLM 옵션 */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * 한 턴 내부 history 압축. 지정 시 매 도구 라운드 후 오래된 큰 tool_result 를
   * 결정적으로 프루닝한다. 미지정이면 비활성(기존 동작 유지).
   */
  compaction?: LoopCompactionOptions;
}

const DEFAULT_MAX_ITERATIONS = 25;

export function createReactArchitecture(options: ReactOptions = {}): AgentArchitecture {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  return {
    name: 'react',
    systemPrompt: options.systemPrompt,

    async *loop(services: RuntimeServices, input: AgentInput): AsyncGenerator<AgentEvent> {
      const history: LLMMessage[] = [];

      if (input.resumeContext) {
        // Resume: hydrate from saved architecture history, inject tool_result, skip user-prompt push
        history.push(...input.resumeContext.architectureHistory);
        history.push({
          role: 'tool_result',
          content: [{
            type: 'tool_result',
            id: input.resumeContext.resumedCallId,
            content: formatResultForLLM(input.resumeContext.toolResult),
            isError: isErrorResult(input.resumeContext.toolResult),
          }],
        });
        // memory.append for resume is intentionally skipped — the user-facing turn was
        // already recorded in ConversationStore (memory) during the original execution.
      } else {
        // Normal entry: existing setup (unchanged)
        // 1. 이전 대화 히스토리
        const memoryHistory = await services.memory.getHistory();
        for (const msg of memoryHistory) {
          history.push({ role: msg.role, content: msg.content });
        }
        for (const prev of input.history ?? []) {
          history.push({ role: prev.role, content: prev.content });
        }

        // 2. 현재 사용자 입력
        const userContent = userContentForInput(input);
        history.push({ role: 'user', content: userContent });
        await services.memory.append({ role: 'user', content: input.prompt });
      }

      const allToolCalls: { name: string; input: unknown }[] = [];
      let lastContent = '';
      // 턴 전체 토큰 usage 누적 — done 이벤트로 표면화한다(pi 드라이버·Multica
      // usage 회계가 provider 실 토큰을 받게). provider 가 usage 를 안 주면 undefined.
      const turnUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
      let sawUsage = false;

      // 실행 중 주입(steer)된 user 메시지를 history + memory 에 도착순으로 합류시킨다.
      // tool_result 뒤 user 메시지는 toolImageMessages 와 동일한 시퀀스라 안전.
      const absorbSteers = async (): Promise<number> => {
        const steers = services.drainSteers?.() ?? [];
        for (const s of steers) {
          history.push(s);
          if (typeof s.content === 'string') {
            await services.memory.append({ role: 'user', content: s.content });
          }
        }
        return steers.length;
      };

      // 3. ReAct 루프
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (services.signal.aborted) return;
        // 직전 LLM/도구 실행 동안 주입된 steer 를 다음 LLM 호출 전에 합류.
        await absorbSteers();

        let response: LLMResponse;
        try {
          response = yield* streamLlm(
            services.llm.stream(history, {
              systemPrompt: options.systemPrompt,
              model: options.model,
              maxTokens: options.maxTokens,
              temperature: options.temperature,
              signal: services.signal,
              tools: services.tools.list().map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
            }),
            options.model ?? '',
          );
        } catch (err) {
          if (services.signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          yield { type: 'error', message };
          return;
        }

        lastContent = response.content;

        if (response.usage) {
          turnUsage.promptTokens += response.usage.promptTokens ?? 0;
          turnUsage.completionTokens += response.usage.completionTokens ?? 0;
          turnUsage.cachedTokens += response.usage.cachedTokens ?? 0;
          sawUsage = true;
        }

        // thinking/text 는 streamLlm 이 델타로 이미 방출 — 여기서 재방출하지 않는다.

        // 도구 호출이 없으면 종료 — 단, 종료 직전 주입된 steer 가 있으면 끝내지 않고 이어간다.
        if (!response.toolCalls || response.toolCalls.length === 0) {
          history.push({ role: 'assistant', content: response.content });
          await services.memory.append({ role: 'assistant', content: response.content });
          if ((await absorbSteers()) > 0) {
            continue;
          }
          yield {
            type: 'done',
            content: response.content,
            toolCalls: allToolCalls,
            usage: sawUsage ? turnUsage : undefined,
            model: options.model,
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
        const toolResults = await executeToolCalls(services, response.toolCalls);

        if (services.signal.aborted) return;

        // tool_result emit + history에 추가할 블록 생성
        const toolResultBlocks: { type: 'tool_result'; id: string; content: string; isError: boolean }[] = [];
        const toolImageMessages: LLMMessage[] = [];
        let suspended: { pendingId: string; toolCallId: string } | null = null;
        for (const { tc, result, isError } of toolResults) {
          yield { type: 'tool_result', id: tc.id, name: tc.name, result, isError };

          if (
            result &&
            typeof result === 'object' &&
            (result as { type?: string }).type === 'suspend'
          ) {
            suspended = {
              pendingId: (result as { pendingId: string }).pendingId,
              toolCallId: tc.id,
            };
            break;
          }

          toolResultBlocks.push({
            type: 'tool_result',
            id: tc.id,
            content: formatResultForLLM(result),
            isError,
          });
          const image = imageResultForLLM(result);
          if (image) {
            toolImageMessages.push({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Tool ${tc.name} returned an image for call ${tc.id}. Use this image as visual context for the current task.`,
                },
                image,
              ],
            });
          }
        }

        if (suspended) {
          yield { type: 'suspended', pendingId: suspended.pendingId, toolCallId: suspended.toolCallId };
          await services.onSuspend?.({
            pendingId: suspended.pendingId,
            toolCallId: suspended.toolCallId,
            architectureHistory: [...history],
          });
          return;
        }

        // tool_result 메시지 history에 추가
        history.push({
          role: 'tool_result',
          content: toolResultBlocks,
        });
        history.push(...toolImageMessages);

        // 한 턴 내부 history 프루닝(결정적) + 크로스턴 memory 컴팩션 + tool pair sanitization
        if (options.compaction) pruneLoopHistory(history, options.compaction);
        await services.memory.compact();
        sanitizeToolPairsInPlace(history);
      }

      // max iterations 도달
      yield {
        type: 'done',
        content: lastContent || '(max iterations reached)',
        toolCalls: allToolCalls,
        usage: sawUsage ? turnUsage : undefined,
        model: options.model,
      };
    },
  };
}
