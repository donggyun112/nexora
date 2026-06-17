/**
 * Plan-Execute Architecture — plan mode 를 공식화한 사고 패턴.
 *
 * Claude Code 의 plan mode 와 동형: 두 phase 로 나뉘고, phase 가 도구 노출을 게이팅한다.
 *
 *   1. **PLAN phase** — 리서치/탐색 도구만 노출. 마무리(submit_*)·변경 도구는 *숨긴다*.
 *      에이전트는 지형을 훑고 계획을 세운 뒤, exitPlanTool 을 호출해 "계획 끝"을 신호한다.
 *   2. **EXECUTE phase** — exitPlanTool 호출 후 전이. 전체 도구 노출 → 계획대로 실행하고
 *      마무리(submit_*)한다.
 *
 * 즉 "계획을 무조건 먼저" 가 프롬프트 부탁이 아니라 **코드 게이트**다 — PLAN phase 에선
 * 마무리 도구가 애초에 LLM 에 노출되지 않으므로 계획 없이 끝낼 수 없다. *무엇을* 계획·
 * 리서치할지는 모델의 판단, *plan→execute 순서* 만 아키텍처가 강제한다.
 *
 * react.ts 와 도구 실행·history 위생 로직(loop-helpers.ts)을 공유한다.
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
  sanitizeToolPairsInPlace,
} from './loop-helpers.js';

export interface PlanExecuteOptions {
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** 전체 안전 상한 (도구 호출 라운드, 기본 40). */
  maxIterations?: number;
  /** PLAN→EXECUTE 전이를 신호하는 도구 이름 (예: 'submit_research_plan'). 등록된 실제 도구여야 한다. */
  exitPlanTool: string;
  /** EXECUTE phase 에서만 노출할 도구 — PLAN phase 에선 숨긴다 (예: ['submit_keywords', 'request_keyword_review']). */
  executePhaseTools?: string[];
  /** PLAN phase 첫 turn 에 주입 — 계획을 먼저 세우게 한다. */
  planPrompt?: string;
}

const DEFAULT_MAX_ITERATIONS = 40;
const DEFAULT_PLAN_PROMPT =
  '지금은 PLAN 단계다. 마무리 도구는 아직 노출되지 않았다 — 계획 없이 끝낼 수 없다. ' +
  '먼저 지형을 훑어(현재 화두/최신 동향, 경쟁이 미는 것, 수요·의도 클러스터) 리서치 질문을 ' +
  'sub-question 몇 개로 분해한 계획을 세운다. 계획이 서면 plan 제출 도구를 호출해 EXECUTE 로 넘어간다.';

export function createPlanExecuteArchitecture(options: PlanExecuteOptions): AgentArchitecture {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const exitPlanTool = options.exitPlanTool;
  const executePhaseTools = new Set(options.executePhaseTools ?? []);
  const planPrompt = options.planPrompt ?? DEFAULT_PLAN_PROMPT;

  // phase 별로 LLM 에 노출할 도구를 필터한다. 이게 plan mode 게이팅의 본체.
  const toolsForPhase = (services: RuntimeServices, phase: 'plan' | 'execute') => {
    return services.tools.list()
      .filter((t) => {
        if (phase === 'plan') return !executePhaseTools.has(t.name); // 마무리 도구 숨김
        return t.name !== exitPlanTool;                              // execute 에선 plan 종료 도구 숨김
      })
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  };

  return {
    name: 'plan-execute',
    systemPrompt: options.systemPrompt,

    async *loop(services: RuntimeServices, input: AgentInput): AsyncGenerator<AgentEvent> {
      const history: LLMMessage[] = [];
      // PLAN 게이트는 '새 대화의 첫 turn' 에만 건다. resume(계획 후 중단) 과 이전 history 가
      // 실려오는 후속/부활 turn 은 EXECUTE 로 시작 — 매 turn PLAN 재진입(재계획) 방지.
      let phase: 'plan' | 'execute' = 'plan';

      if (input.resumeContext) {
        phase = 'execute';
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
      } else {
        const memoryHistory = await services.memory.getHistory();
        for (const msg of memoryHistory) {
          history.push({ role: msg.role, content: msg.content });
        }
        for (const prev of input.history ?? []) {
          history.push({ role: prev.role, content: prev.content });
        }
        // 이전 turn 이 실려있으면 계획은 이미 첫 turn 에 했다 → EXECUTE 로 시작.
        if (history.length > 0) phase = 'execute';

        const promptText = phase === 'plan' && planPrompt ? `${input.prompt}\n\n${planPrompt}` : input.prompt;
        const userContent = input.images && input.images.length > 0
          ? [
              { type: 'text' as const, text: promptText },
              ...input.images.map(img => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })),
            ]
          : promptText;
        history.push({ role: 'user', content: userContent });
        await services.memory.append({ role: 'user', content: input.prompt });
      }

      const allToolCalls: { name: string; input: unknown }[] = [];
      let lastContent = '';

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

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (services.signal.aborted) return;
        await absorbSteers();

        let response: LLMResponse;
        try {
          response = await services.llm.complete(history, {
            systemPrompt: options.systemPrompt,
            model: options.model,
            maxTokens: options.maxTokens,
            temperature: options.temperature,
            signal: services.signal,
            tools: toolsForPhase(services, phase),
          });
        } catch (err) {
          if (services.signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          yield { type: 'error', message };
          return;
        }

        lastContent = response.content;
        if (response.content) {
          yield { type: 'text', text: response.content };
        }

        if (!response.toolCalls || response.toolCalls.length === 0) {
          history.push({ role: 'assistant', content: response.content });
          await services.memory.append({ role: 'assistant', content: response.content });
          if ((await absorbSteers()) > 0) continue;
          yield { type: 'done', content: response.content, toolCalls: allToolCalls };
          return;
        }

        history.push({
          role: 'assistant',
          content: [
            ...(response.content ? [{ type: 'text' as const, text: response.content }] : []),
            ...response.toolCalls.map(tc => ({ type: 'tool_call' as const, id: tc.id, name: tc.name, arguments: tc.arguments })),
          ],
        });

        for (const tc of response.toolCalls) {
          allToolCalls.push({ name: tc.name, input: tc.arguments });
          yield { type: 'tool_call', id: tc.id, name: tc.name, input: tc.arguments };
        }

        const toolResults = await executeToolCalls(services, response.toolCalls);
        if (services.signal.aborted) return;

        const toolResultBlocks: { type: 'tool_result'; id: string; content: string; isError: boolean }[] = [];
        const toolImageMessages: LLMMessage[] = [];
        let suspended: { pendingId: string; toolCallId: string } | null = null;
        let planSubmitted = false;

        for (const { tc, result, isError } of toolResults) {
          yield { type: 'tool_result', id: tc.id, name: tc.name, result, isError };

          if (result && typeof result === 'object' && (result as { type?: string }).type === 'suspend') {
            suspended = { pendingId: (result as { pendingId: string }).pendingId, toolCallId: tc.id };
            break;
          }

          if (phase === 'plan' && tc.name === exitPlanTool && !isError) planSubmitted = true;

          toolResultBlocks.push({ type: 'tool_result', id: tc.id, content: formatResultForLLM(result), isError });
          const image = imageResultForLLM(result);
          if (image) {
            toolImageMessages.push({
              role: 'user',
              content: [
                { type: 'text', text: `Tool ${tc.name} returned an image for call ${tc.id}. Use this image as visual context for the current task.` },
                image,
              ],
            });
          }
        }

        if (suspended) {
          yield { type: 'suspended', pendingId: suspended.pendingId, toolCallId: suspended.toolCallId };
          await services.onSuspend?.({ pendingId: suspended.pendingId, toolCallId: suspended.toolCallId, architectureHistory: [...history] });
          return;
        }

        history.push({ role: 'tool_result', content: toolResultBlocks });
        history.push(...toolImageMessages);

        // PLAN→EXECUTE 전이 — exitPlanTool 이 정상 실행된 뒤 다음 turn 부터 전체 도구 노출.
        if (planSubmitted) {
          phase = 'execute';
          yield { type: 'progress', message: 'plan-execute: 계획 완료 → EXECUTE 단계' };
        }

        await services.memory.compact();
        sanitizeToolPairsInPlace(history);
      }

      yield { type: 'done', content: lastContent || '(max iterations reached)', toolCalls: allToolCalls };
    },
  };
}
