/**
 * Verification Loop (grader/judge) — "Loop 2" of loop engineering.
 *
 * Wraps an agent runtime with a grader: after the agent finishes, its output is
 * scored against a rubric. On failure the agent is re-run with the grader's
 * feedback appended, up to `maxAttempts`. This is the framework primitive for
 * trading latency/cost for output quality.
 *
 * Why a runtime wrapper (not middleware): `afterExecution` middleware is
 * observe-only — it cannot re-enter the loop with feedback. The verification
 * loop needs to re-run execution, so it composes AgentRuntime like
 * FallbackLlmProvider composes LLMProvider.
 *
 * Per-attempt isolation: takes a runtime *factory* so each attempt runs on a
 * fresh harness (no state carry-over between tries). bootstrapAgent's
 * `createRuntime` is already a factory, so this composes cleanly:
 *
 *   createRuntime: (args) =>
 *     createVerifiedRuntime(() => buildRuntime(args), grader, { maxAttempts: 3 })
 */
import type {
  AgentEvent,
  AgentInput,
  AgentRuntime,
  LLMProvider,
} from '@dongkseo/contracts';

export interface GradeResult {
  /** Whether the output meets the bar. */
  pass: boolean;
  /** Optional numeric score in [0, 1] (for thresholds / logging). */
  score?: number;
  /** Short, actionable note fed back to the agent on retry. */
  feedback?: string;
}

/** Scores an agent's final output against some bar. Deterministic or LLM-backed. */
export type Grader = (
  output: string,
  input: AgentInput,
) => GradeResult | Promise<GradeResult>;

/**
 * Deterministic grader from a predicate/scoring function. Use for checks that
 * don't need a model (length, required sections, regex, JSON-schema validity…).
 */
export function createRubricGrader(
  grade: (output: string, input: AgentInput) => GradeResult | Promise<GradeResult>,
): Grader {
  return grade;
}

export interface LlmJudgeOptions {
  /** Provider used for judging (can differ from the agent's own LLM). */
  llm: LLMProvider;
  /** The rubric the output is graded against. */
  rubric: string;
  /** Minimum score to pass when the judge omits an explicit `pass`. Default 0.7. */
  passThreshold?: number;
  /** Optional model override for the judge call. */
  model?: string;
}

/**
 * LLM-as-judge grader. Asks a model to score the output against the rubric and
 * return JSON `{score, pass, feedback}`. Tolerant of fences/prose around JSON.
 */
export function createLlmJudgeGrader(options: LlmJudgeOptions): Grader {
  const threshold = options.passThreshold ?? 0.7;
  return async (output, input) => {
    const system =
      'You are a strict evaluator. Score the assistant OUTPUT against the RUBRIC. ' +
      'Reply with ONLY compact JSON, no prose and no code fences: ' +
      '{"score": <number 0..1>, "pass": <boolean>, "feedback": "<one short sentence on what to fix>"}.';
    const user = `RUBRIC:\n${options.rubric}\n\nTASK:\n${input.prompt}\n\nOUTPUT:\n${output}`;
    const res = await options.llm.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { model: options.model, temperature: 0 },
    );
    const parsed = parseJudgeJson(res.content);
    const score = typeof parsed.score === 'number' ? parsed.score : parsed.pass ? 1 : 0;
    const pass = typeof parsed.pass === 'boolean' ? parsed.pass : score >= threshold;
    return { pass: pass && score >= threshold, score, feedback: parsed.feedback };
  };
}

function parseJudgeJson(text: string): { score?: number; pass?: boolean; feedback?: string } {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch {
    return {};
  }
}

export interface VerifiedRuntimeOptions {
  /** Total tries including the first (default 2 = one try + one retry). */
  maxAttempts?: number;
  /** How rejection feedback is injected into the next attempt's prompt. */
  feedbackTemplate?: (feedback: string, rejectedAttempt: number) => string;
  /** Observability hook called with each grade. */
  onGrade?: (grade: GradeResult, attempt: number) => void;
  /** If the grader itself throws, treat as pass (default true) — availability over strictness. */
  failOpen?: boolean;
}

const defaultFeedbackTemplate = (feedback: string, rejectedAttempt: number): string =>
  `[Reviewer feedback — attempt ${rejectedAttempt} was rejected]\n${feedback}\n` +
  `Revise your previous answer to satisfy the rubric.`;

/**
 * Wrap a runtime factory with a verification loop. Each attempt runs a fresh
 * runtime; a rejected attempt's events are discarded and the agent retries with
 * feedback. The accepted (or final) attempt's events — including its `done` —
 * are streamed to the consumer, preceded by a `progress` marker.
 */
export function createVerifiedRuntime(
  createInner: () => AgentRuntime,
  grader: Grader,
  options: VerifiedRuntimeOptions = {},
): AgentRuntime {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const failOpen = options.failOpen ?? true;
  const feedbackTemplate = options.feedbackTemplate ?? defaultFeedbackTemplate;
  let current: AgentRuntime | undefined;
  let activeAbort: AbortController | undefined;

  return {
    abort(): void {
      activeAbort?.abort();
      current?.abort();
    },
    steer(text: string): boolean {
      return current?.steer?.(text) ?? false;
    },
    async *execute(input: AgentInput): AsyncGenerator<AgentEvent> {
      let feedback: string | undefined;
      const runAbort = new AbortController();
      activeAbort = runAbort;

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (runAbort.signal.aborted) return;
          const attemptInput: AgentInput = feedback
            ? { ...input, prompt: `${input.prompt}\n\n${feedbackTemplate(feedback, attempt - 1)}` }
            : input;

          current = createInner();
          const buffered: AgentEvent[] = [];
          let doneContent: string | undefined;
          let terminal: 'done' | 'error' | 'suspended' | undefined;

          for await (const ev of current.execute(attemptInput)) {
            buffered.push(ev);
            if (ev.type === 'done') {
              doneContent = ev.content;
              terminal = 'done';
            } else if (ev.type === 'error') {
              terminal = 'error';
            } else if (ev.type === 'suspended') {
              terminal = 'suspended';
            }
          }

          if (runAbort.signal.aborted) return;

          // A suspended/errored run can't be graded or retried — stream it as-is.
          if (terminal !== 'done' || doneContent === undefined) {
            yield* buffered;
            return;
          }

          let grade: GradeResult;
          try {
            grade = await grader(doneContent, input);
          } catch (err) {
            if (!failOpen) throw err;
            grade = { pass: true, feedback: `grader error: ${(err as Error).message}` };
          }
          if (runAbort.signal.aborted) return;
          options.onGrade?.(grade, attempt);

          const lastAttempt = attempt === maxAttempts;
          if (grade.pass || lastAttempt) {
            const scoreStr = grade.score != null ? ` score=${grade.score.toFixed(2)}` : '';
            yield {
              type: 'progress',
              message: `[verify] ${grade.pass ? 'passed' : 'failed (max attempts reached)'}${scoreStr} (attempt ${attempt}/${maxAttempts})`,
            };
            yield* buffered;
            return;
          }

          const scoreStr = grade.score != null ? ` score=${grade.score.toFixed(2)}` : '';
          yield {
            type: 'progress',
            message: `[verify] attempt ${attempt} rejected${scoreStr} — retrying`,
          };
          if (runAbort.signal.aborted) return;
          feedback = grade.feedback ?? 'Output did not meet the rubric.';
        }
      } finally {
        if (activeAbort === runAbort) activeAbort = undefined;
        current = undefined;
      }
    },
  };
}
