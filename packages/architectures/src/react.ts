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
  LLMContentBlock,
  LLMResponse,
  ToolBatchResult,
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
      }

      const allToolCalls: { name: string; input: unknown }[] = [];
      let lastContent = '';

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
          response = await services.llm.complete(history, {
            systemPrompt: options.systemPrompt,
            model: options.model,
            maxTokens: options.maxTokens,
            temperature: options.temperature,
            signal: services.signal,
            tools: services.tools.list().map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
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

type ToolCall = NonNullable<LLMResponse['toolCalls']>[number];

async function executeToolCalls(
  services: RuntimeServices,
  toolCalls: ToolCall[],
): Promise<{ tc: ToolCall; result: unknown; isError: boolean }[]> {
  if (services.tools.executeBatch) {
    const batchResults = await services.tools.executeBatch(
      toolCalls.map(tc => ({ callId: tc.id, name: tc.name, input: tc.arguments })),
      services.signal,
    );
    return mergeBatchResults(toolCalls, batchResults);
  }

  const results: { tc: ToolCall; result: unknown; isError: boolean }[] = [];
  for (const tc of toolCalls) {
    if (services.signal.aborted) break;
    const result = await services.tools.execute(tc.name, tc.id, tc.arguments, services.signal);
    results.push({ tc, result, isError: isErrorResult(result) });
  }
  return results;
}

function mergeBatchResults(
  toolCalls: ToolCall[],
  batchResults: ToolBatchResult[],
): { tc: ToolCall; result: unknown; isError: boolean }[] {
  const byId = new Map(batchResults.map(result => [result.callId, result]));
  return toolCalls.map((tc) => {
    const result = byId.get(tc.id);
    if (!result) {
      return {
        tc,
        result: { type: 'error' as const, message: `Missing tool result: ${tc.id}` },
        isError: true,
      };
    }
    return { tc, result: result.result, isError: result.isError };
  });
}

/**
 * Sanitize tool_call/tool_result pairs in-place after compaction.
 * Ensures every tool_call has a matching tool_result (prevents API crashes).
 *
 * Strategy:
 * 1. Collect all call IDs and result IDs
 * 2. Remove orphaned tool_result blocks (no matching call)
 * 3. For each orphaned tool_call, insert a stub tool_result message
 *    IMMEDIATELY after the assistant message containing the call
 *    (Anthropic/OpenAI require results right after their calls)
 */
function sanitizeToolPairsInPlace(history: LLMMessage[]): void {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  // Pass 1: collect IDs
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

  // Pass 2: remove orphaned tool_result messages (results without matching calls)
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'tool_result' || !Array.isArray(msg.content)) continue;
    // Filter out individual orphaned result blocks
    const blocks = msg.content as LLMContentBlock[];
    const surviving = blocks.filter(
      b => b.type !== 'tool_result' || callIds.has(b.id),
    );
    if (surviving.length === 0) {
      history.splice(i, 1);
    } else if (surviving.length !== blocks.length) {
      msg.content = surviving;
    }
  }

  // Pass 3: find orphaned calls and insert stub results IMMEDIATELY after
  // the assistant message that owns them (maintains API sequencing)
  const orphanedIds = new Set([...callIds].filter(id => !resultIds.has(id)));
  if (orphanedIds.size === 0) return;

  // Walk forward and insert stubs right after each assistant message with orphans
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const orphansInMsg = (msg.content as LLMContentBlock[])
      .filter(b => b.type === 'tool_call' && orphanedIds.has(b.id))
      .map(b => (b as { id: string }).id);

    if (orphansInMsg.length === 0) continue;

    const stubMsg: LLMMessage = {
      role: 'tool_result',
      content: orphansInMsg.map(id => ({
        type: 'tool_result' as const,
        id,
        content: '[result lost during context compaction]',
        isError: false,
      })),
    };

    // Insert right after this assistant message
    history.splice(i + 1, 0, stubMsg);
    i++; // skip the inserted message

    for (const id of orphansInMsg) orphanedIds.delete(id);
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

function imageResultForLLM(result: unknown): Extract<LLMContentBlock, { type: 'image' }> | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { type?: string; data?: string; mimeType?: string };
  if (r.type !== 'image' || typeof r.data !== 'string' || typeof r.mimeType !== 'string') return null;
  return { type: 'image', data: r.data, mimeType: r.mimeType };
}
