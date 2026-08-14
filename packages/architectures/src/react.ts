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
  SuspendRequest,
  ToolBatchCall,
} from '@dongkseo/contracts';
import { OrchestrationControlError } from '@dongkseo/contracts';
import {
  askBeforeFinish,
  askBeforeModel,
  controlContext,
  executeToolCalls,
  absorbRuntimeInputs,
  contextMessagesFromResult,
  formatResultForLLM,
  imageBlocksFromResult,
  injectResumedToolResult,
  pruneLoopHistory,
  sanitizeToolPairsInPlace,
  selectToolCallsForExecution,
  announceSuspend,
  suspendHistorySnapshot,
  toolTerminatesLoop,
  userContentForInput,
  type LoopCompactionOptions,
  type ToolResultBlock,
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
        // Resume: hydrate from saved architecture history and settle the parked call —
        // onResume 이 설정돼 있으면 재검증(도구 재실행/거부/재파킹), 아니면 답변 주입.
        // 재파킹했으면 여기서 턴이 끝난다.
        if (!(yield* injectResumedToolResult(services, input.resumeContext, history))) return;
        // memory.append for resume is intentionally skipped — the user-facing turn was
        // already recorded in ConversationStore (memory) during the original execution.
      } else {
        // Normal entry: push rich history directly (tool/image 블록 그대로)
        // 1. 이전 대화 히스토리 (rich — tool/image 블록 그대로)
        history.push(...await services.memory.getHistory());
        history.push(...(input.history ?? []));

        // 2. 현재 사용자 입력
        if (!services.inputs) {
          const userContent = userContentForInput(input);
          history.push({
            ...(input.inputId ? { id: input.inputId } : {}),
            role: 'user',
            content: userContent,
          });
        }
      }

      const callsMade: ToolBatchCall[] = [];
      let lastContent = '';
      // 턴 전체 토큰 usage 누적 — done 이벤트로 표면화한다(pi 드라이버·Multica
      // usage 회계가 provider 실 토큰을 받게). provider 가 usage 를 안 주면 undefined.
      const turnUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
      let sawUsage = false;

      // 실행 중 주입(steer)된 user 메시지를 history 에 도착순으로 합류시킨다.
      // tool_result 뒤 user 메시지는 toolImageMessages 와 동일한 시퀀스라 안전.
      // onInputs 가 설정돼 있으면 합류 전에 걸러진다.
      const absorbInputs = (turn: number, text: string) =>
        absorbRuntimeInputs(services, history, controlContext(turn, history, callsMade, text));
      // 종료 이벤트는 어느 경로로 끝나든 같은 모양이다.
      const done = (content: string): AgentEvent => ({
        type: 'done',
        content,
        toolCalls: callsMade.map(({ name, input }) => ({ name, input })),
        usage: sawUsage ? turnUsage : undefined,
        model: options.model,
      });

      // 3. ReAct 루프
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (services.signal.aborted) return;
        // 직전 LLM/도구 실행 동안 주입된 steer 를 다음 LLM 호출 전에 합류.
        if (typeof await absorbInputs(iteration, lastContent) !== 'number') {
          yield done(lastContent);
          return;
        }
        // 모델을 부르기 직전의 마지막 관문 — python `_admit_turn_inputs` 의 before_model.
        if (await askBeforeModel(
          services,
          history,
          controlContext(iteration, history, callsMade, lastContent),
        )) {
          yield done(lastContent);
          return;
        }
        await services.tools.prepare?.(history);

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
          if (err instanceof OrchestrationControlError) throw err;
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
          const late = await absorbInputs(iteration, response.content);
          if (typeof late !== 'number') {
            yield done(response.content);
            return;
          }
          if (late > 0) continue;
          // 마지막 한마디 — python `_decide_finish` 의 before_finish 자리. `proceed` 면
          // 종료가 거부된 것이므로 steers 를 안고 한 라운드 더 돈다. 게이트가 준 reason 은
          // 바꾸지 않는다(다만 AgentEvent 'done' 에 이유를 실을 필드가 없어 표면화되진 않는다).
          const reason = await askBeforeFinish(
            services,
            history,
            controlContext(iteration, history, callsMade, response.content),
            'completed',
          );
          if (reason === undefined) continue;
          yield done(response.content);
          return;
        }

        const toolCalls = selectToolCallsForExecution(services, response.toolCalls);

        // assistant 메시지 (텍스트 + 실제 실행할 tool_call) history에 추가
        history.push({
          role: 'assistant',
          content: [
            ...(response.content ? [{ type: 'text' as const, text: response.content }] : []),
            ...toolCalls.map(tc => ({
              type: 'tool_call' as const,
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
          ],
        });

        // tool_call 이벤트는 실행 시작 전에 emit
        for (const tc of toolCalls) {
          callsMade.push({ callId: tc.id, name: tc.name, input: tc.arguments });
          yield { type: 'tool_call', id: tc.id, name: tc.name, input: tc.arguments };
        }

        // 도구 병렬 실행 (Promise.all 안에서 yield 불가하므로 결과 모은 후 일괄 emit)
        const toolResults = await executeToolCalls(
          services,
          toolCalls,
          controlContext(iteration, history, callsMade, response.content),
        );

        if (services.signal.aborted) return;

        // tool_result emit + history에 추가할 블록 생성
        const toolResultBlocks: ToolResultBlock[] = [];
        const toolImageMessages: LLMMessage[] = [];
        const toolContextMessages: LLMMessage[] = [];
        // call 은 체크포인트에 남는다 — 재개 시 onResume 이 그 호출을 재검증하고,
        // continue 면 이름·입력으로 실제 실행해야 한다.
        let suspended: {
          pendingId: string;
          toolCallId: string;
          call: { name: string; input: unknown };
          // 게이트가 파킹한 경우의 질문. 런타임이 파킹을 기록한 뒤 발행한다.
          request?: SuspendRequest;
        } | null = null;
        for (const { tc, result, isError, suspendRequest } of toolResults) {
          yield { type: 'tool_result', id: tc.id, name: tc.name, result, isError };

          if (
            result &&
            typeof result === 'object' &&
            (result as { type?: string }).type === 'suspend'
          ) {
            suspended ??= {
              pendingId: (result as { pendingId: string }).pendingId,
              toolCallId: tc.id,
              call: { name: tc.name, input: tc.arguments },
              ...(suspendRequest ? { request: suspendRequest } : {}),
            };
            continue;
          }

          toolResultBlocks.push({
            type: 'tool_result',
            id: tc.id,
            content: formatResultForLLM(result),
            isError,
          });
          const images = imageBlocksFromResult(result);
          if (images.length > 0) {
            toolImageMessages.push({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Tool ${tc.name} returned ${images.length === 1 ? 'an image' : `${images.length} images`} for call ${tc.id}. Use ${images.length === 1 ? 'this image' : 'these images'} as visual context for the current task.`,
                },
                ...images,
              ],
            });
          }
          toolContextMessages.push(...contextMessagesFromResult(result));
        }

        if (suspended) {
          yield { type: 'suspended', pendingId: suspended.pendingId, toolCallId: suspended.toolCallId };
          await announceSuspend(services, {
            pendingId: suspended.pendingId,
            toolCallId: suspended.toolCallId,
            architectureHistory: suspendHistorySnapshot(
              history,
              toolResultBlocks,
              suspended.toolCallId,
            ),
            completedResults: toolResultBlocks,
            call: suspended.call,
            ...(suspended.request ? { request: suspended.request } : {}),
          });
          return;
        }

        // tool_result 메시지 history에 추가
        history.push({
          role: 'tool_result',
          content: toolResultBlocks,
        });
        history.push(...toolImageMessages);
        history.push(...toolContextMessages);

        // 한 턴 내부 history 프루닝(결정적) + 크로스턴 memory 컴팩션 + tool pair sanitization
        if (options.compaction) pruneLoopHistory(history, options.compaction);
        await services.memory.compact();
        sanitizeToolPairsInPlace(history);

        // 라운드 종료 판정. 결과·이벤트·history 는 이미 다 반영된 뒤라, 멈춰도 다음 LLM
        // 턴만 생략된다. 도구 주도(submit/finish) 종료 — 성공한 terminatesLoop 호출.
        // error 는 회복 기회를 준다.
        //
        // 이 경로는 `beforeFinish` 를 타지 않는다: python `_tool_round_stop_reason` 이
        // `ended_by_tool` 을 그대로 종료 사유로 돌려주고, `_decide_finish`(= before_finish
        // 를 묻는 유일한 자리)는 도구 없는 라운드에서만 불린다.
        const stopByTool = toolResults.some(
          ({ tc, isError }) => !isError && toolTerminatesLoop(services, tc),
        );
        if (stopByTool) {
          yield done(lastContent || '(tool ended the run)');
          return;
        }
      }

      // max iterations 도달. 여기서는 `beforeFinish` 를 묻지 않는다 — 상한이 게이트보다
      // 먼저다. 물으면 항상 veto 하는 게이트가 루프가 노출하는 유일한 반복 상한을 무한히
      // 우회한다(python `_decide_finish` 가 turn cap 을 before_finish 앞에 두는 이유).
      yield done(lastContent || '(max iterations reached)');
    },
  };
}
