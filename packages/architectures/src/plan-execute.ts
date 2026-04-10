/**
 * PlanExecute Architecture — Plan → Execute → Replan 사이클.
 *
 * 1. Plan: LLM이 단계별 계획 생성
 * 2. Execute: 각 단계를 별도 LLM 호출로 실행 (도구 사용 가능)
 * 3. Replan: 실행 결과를 보고 계획 갱신 (선택)
 *
 * 참고: Deep Agents의 sub-agent 패턴 + LangGraph plan-and-execute
 */

import type {
  AgentArchitecture,
  AgentEvent,
  AgentInput,
  RuntimeServices,
  LLMMessage,
} from '@nexora/contracts';

export interface PlanExecuteOptions {
  systemPrompt?: string;
  /** 최대 단계 수 (기본 10) */
  maxSteps?: number;
  /** Replan 활성화 (기본 false) */
  enableReplan?: boolean;
  model?: string;
}

const PLAN_PROMPT = `You are a planner. Break the user's request into a numbered list of concrete steps.
Each step must be actionable in one LLM turn (with tools available).
Output ONLY the numbered list, one step per line. No preamble.`;

const REPLAN_PROMPT = `You are reviewing progress on a multi-step plan.
Given the original goal, completed steps with results, and remaining steps,
output a revised remaining-steps list. Output ONLY the numbered list.`;

export function createPlanExecuteArchitecture(options: PlanExecuteOptions = {}): AgentArchitecture {
  const maxSteps = options.maxSteps ?? 10;

  return {
    name: 'plan-execute',

    async *loop(services: RuntimeServices, input: AgentInput): AsyncGenerator<AgentEvent> {
      // Phase 1: Plan
      yield { type: 'progress', message: 'planning…' };

      let plan: string[];
      try {
        const planResp = await services.llm.complete(
          [{ role: 'user', content: input.prompt }],
          { systemPrompt: PLAN_PROMPT, model: options.model, signal: services.signal },
        );
        plan = parsePlan(planResp.content).slice(0, maxSteps);
        yield { type: 'thinking', content: `Plan:\n${plan.join('\n')}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message };
        return;
      }

      if (plan.length === 0) {
        yield { type: 'done', content: '(no steps produced)', toolCalls: [] };
        return;
      }

      // Phase 2: Execute each step
      const completed: { step: string; result: string }[] = [];
      const allToolCalls: { name: string; input: unknown }[] = [];
      let stepIdx = 0;

      while (stepIdx < plan.length) {
        if (services.signal.aborted) return;
        const step = plan[stepIdx];
        yield { type: 'progress', message: `step ${stepIdx + 1}/${plan.length}: ${step}` };

        const stepHistory: LLMMessage[] = [
          { role: 'user', content: input.prompt },
          ...completed.map(c => ({
            role: 'assistant' as const,
            content: `Completed: ${c.step}\nResult: ${c.result}`,
          })),
          { role: 'user', content: `Now execute step: ${step}` },
        ];

        try {
          const stepResp = await services.llm.complete(stepHistory, {
            systemPrompt: options.systemPrompt ?? 'Execute the requested step concisely. Use tools if needed.',
            model: options.model,
            signal: services.signal,
          });

          if (stepResp.content) yield { type: 'text', text: stepResp.content };

          // 도구 호출 처리 (단일 라운드만)
          let stepResult = stepResp.content;
          if (stepResp.toolCalls && stepResp.toolCalls.length > 0) {
            const toolOutputs: string[] = [];
            for (const tc of stepResp.toolCalls) {
              yield { type: 'tool_call', id: tc.id, name: tc.name, input: tc.arguments };
              allToolCalls.push({ name: tc.name, input: tc.arguments });
              const result = await services.tools.execute(tc.name, tc.id, tc.arguments, services.signal);
              const isError = (result as { type?: string }).type === 'error';
              yield { type: 'tool_result', id: tc.id, name: tc.name, result, isError };
              toolOutputs.push(formatResult(result));
            }
            stepResult = `${stepResp.content}\n\nTool results:\n${toolOutputs.join('\n')}`;
          }

          completed.push({ step, result: stepResult });
          stepIdx++;

          // Replan
          if (options.enableReplan && stepIdx < plan.length) {
            const replanResp = await services.llm.complete(
              [{
                role: 'user',
                content: `Goal: ${input.prompt}\n\nCompleted:\n${completed.map(c => `- ${c.step}: ${c.result}`).join('\n')}\n\nRemaining:\n${plan.slice(stepIdx).map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
              }],
              { systemPrompt: REPLAN_PROMPT, model: options.model, signal: services.signal },
            );
            const newRemaining = parsePlan(replanResp.content);
            if (newRemaining.length > 0) {
              plan = [...plan.slice(0, stepIdx), ...newRemaining];
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          yield { type: 'error', message };
          return;
        }
      }

      // 최종 결과
      const summary = completed.map((c, i) => `${i + 1}. ${c.step}\n   → ${c.result}`).join('\n\n');
      yield { type: 'done', content: summary, toolCalls: allToolCalls };
    },
  };
}

function parsePlan(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(line => line.length > 0);
}

function formatResult(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result);
  const r = result as { type?: string; text?: string; message?: string };
  if (r.type === 'text') return r.text ?? '';
  if (r.type === 'error') return `[ERROR] ${r.message ?? ''}`;
  return JSON.stringify(result);
}
