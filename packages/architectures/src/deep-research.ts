/**
 * DeepResearch Architecture — 다단계 리서치 파이프라인.
 *
 * 4단계: Plan → Research → Evaluate → Compose
 * 평가 단계가 incomplete를 반환하면 follow-up query로 Research 반복.
 *
 * 참고: reference deep-research.ts (auto-work-flow)
 */

import type {
  AgentArchitecture,
  AgentEvent,
  AgentInput,
  RuntimeServices,
  LLMMessage,
} from '@nexora/contracts';

export interface DeepResearchOptions {
  systemPrompt?: string;
  /** 최대 research 반복 횟수 (기본 3) */
  maxResearchIterations?: number;
  model?: string;
}

const PLAN_PROMPT = `You are a research planner. Given a research question, output 3-5 sub-queries to investigate.
Output ONLY the numbered list, one query per line.`;

const RESEARCH_PROMPT = `You are a researcher. Use the tools available to gather information for the given query.
Be thorough but concise. Cite sources when possible.`;

const EVALUATE_PROMPT = `You are evaluating research results for completeness.
Output a JSON object: {"grade": "complete"|"incomplete", "comment": "...", "followUpQueries": ["...", "..."]}.
Mark as complete only if the original goal is fully addressed.`;

const COMPOSE_PROMPT = `You are a writer composing a final research report.
Synthesize the research findings into a clear, structured report. Use markdown headings.`;

export function createDeepResearchArchitecture(
  options: DeepResearchOptions = {},
): AgentArchitecture {
  const maxResearchIterations = options.maxResearchIterations ?? 3;

  return {
    name: 'deep-research',

    async *loop(services: RuntimeServices, input: AgentInput): AsyncGenerator<AgentEvent> {
      const allToolCalls: { name: string; input: unknown }[] = [];

      // Phase 1: Plan
      yield { type: 'progress', message: 'planning research…' };
      let queries: string[];
      try {
        const planResp = await services.llm.complete(
          [{ role: 'user', content: input.prompt }],
          { systemPrompt: PLAN_PROMPT, model: options.model, signal: services.signal },
        );
        queries = parseList(planResp.content);
        yield { type: 'thinking', content: `Sub-queries:\n${queries.join('\n')}` };
      } catch (err) {
        yield { type: 'error', message: errMessage(err) };
        return;
      }

      const findings: string[] = [];

      for (let iteration = 0; iteration < maxResearchIterations; iteration++) {
        if (services.signal.aborted) return;

        // Phase 2: Research each query
        for (const query of queries) {
          if (services.signal.aborted) return;
          yield { type: 'progress', message: `researching: ${query}` };
          try {
            const researchResp = await services.llm.complete(
              [{ role: 'user', content: query }],
              { systemPrompt: RESEARCH_PROMPT, model: options.model, signal: services.signal },
            );

            // 도구 호출
            if (researchResp.toolCalls && researchResp.toolCalls.length > 0) {
              const toolOutputs: string[] = [];
              for (const tc of researchResp.toolCalls) {
                yield { type: 'tool_call', id: tc.id, name: tc.name, input: tc.arguments };
                allToolCalls.push({ name: tc.name, input: tc.arguments });
                const result = await services.tools.execute(tc.name, tc.id, tc.arguments, services.signal);
                const isError = (result as { type?: string }).type === 'error';
                yield { type: 'tool_result', id: tc.id, name: tc.name, result, isError };
                toolOutputs.push(formatResult(result));
              }
              findings.push(`Q: ${query}\n${researchResp.content}\n${toolOutputs.join('\n')}`);
            } else {
              findings.push(`Q: ${query}\nA: ${researchResp.content}`);
            }
          } catch (err) {
            yield { type: 'error', message: errMessage(err) };
            return;
          }
        }

        // Phase 3: Evaluate
        yield { type: 'progress', message: 'evaluating completeness…' };
        let evalResult: { grade: string; comment: string; followUpQueries: string[] };
        try {
          const evalResp = await services.llm.complete(
            [{
              role: 'user',
              content: `Goal: ${input.prompt}\n\nFindings so far:\n${findings.join('\n\n')}`,
            }],
            { systemPrompt: EVALUATE_PROMPT, model: options.model, signal: services.signal },
          );
          evalResult = parseEvaluation(evalResp.content);
          yield { type: 'thinking', content: `Evaluation: ${evalResult.grade} — ${evalResult.comment}` };
        } catch (err) {
          yield { type: 'error', message: errMessage(err) };
          return;
        }

        if (evalResult.grade === 'complete' || evalResult.followUpQueries.length === 0) {
          break;
        }

        queries = evalResult.followUpQueries;
      }

      // Phase 4: Compose
      yield { type: 'progress', message: 'composing report…' };
      try {
        const composeResp = await services.llm.complete(
          [{
            role: 'user',
            content: `Goal: ${input.prompt}\n\nFindings:\n${findings.join('\n\n')}\n\nWrite the final report.`,
          }],
          { systemPrompt: COMPOSE_PROMPT, model: options.model, signal: services.signal },
        );

        if (composeResp.content) yield { type: 'text', text: composeResp.content };
        yield { type: 'done', content: composeResp.content, toolCalls: allToolCalls };
      } catch (err) {
        yield { type: 'error', message: errMessage(err) };
      }
    },
  };
}

function parseList(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(line => line.length > 0);
}

function parseEvaluation(text: string): { grade: string; comment: string; followUpQueries: string[] } {
  // JSON 추출 시도
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        grade?: string;
        comment?: string;
        followUpQueries?: string[];
      };
      return {
        grade: parsed.grade ?? 'incomplete',
        comment: parsed.comment ?? '',
        followUpQueries: parsed.followUpQueries ?? [],
      };
    } catch {
      // fall through
    }
  }
  return { grade: 'complete', comment: '(unparseable)', followUpQueries: [] };
}

function formatResult(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result);
  const r = result as { type?: string; text?: string; message?: string };
  if (r.type === 'text') return r.text ?? '';
  if (r.type === 'error') return `[ERROR] ${r.message ?? ''}`;
  return JSON.stringify(result);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
