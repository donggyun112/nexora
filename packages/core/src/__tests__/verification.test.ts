import { describe, it, expect } from 'vitest';
import {
  createVerifiedRuntime,
  createRubricGrader,
  type GradeResult,
} from '../verification.js';
import type { AgentEvent, AgentInput, AgentRuntime } from '@dongkseo/contracts';

/** Runtime factory that returns the next scripted response on each attempt. */
function scriptedRuntimeFactory(responses: string[]): {
  factory: () => AgentRuntime;
  seenPrompts: string[];
} {
  let attempt = 0;
  const seenPrompts: string[] = [];
  const factory = (): AgentRuntime => ({
    abort() {},
    async *execute(input: AgentInput): AsyncGenerator<AgentEvent> {
      seenPrompts.push(input.prompt);
      const content = responses[Math.min(attempt, responses.length - 1)];
      attempt++;
      yield { type: 'text', text: content };
      yield { type: 'done', content, toolCalls: [] };
    },
  });
  return { factory, seenPrompts };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const doneContent = (events: AgentEvent[]): string | undefined =>
  events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')?.content;

describe('createVerifiedRuntime', () => {
  it('passes on first attempt → single run, output unchanged', async () => {
    const { factory, seenPrompts } = scriptedRuntimeFactory(['good answer']);
    const grader = createRubricGrader(() => ({ pass: true, score: 1 }));
    const rt = createVerifiedRuntime(factory, grader, { maxAttempts: 3 });

    const events = await collect(rt.execute({ prompt: 'do it' }));

    expect(doneContent(events)).toBe('good answer');
    expect(seenPrompts).toEqual(['do it']); // no retry
  });

  it('rejects then retries with feedback, accepts second attempt', async () => {
    const { factory, seenPrompts } = scriptedRuntimeFactory(['bad', 'fixed']);
    const grader = createRubricGrader((output): GradeResult =>
      output === 'fixed'
        ? { pass: true, score: 1 }
        : { pass: false, score: 0.2, feedback: 'must say fixed' },
    );
    const rt = createVerifiedRuntime(factory, grader, { maxAttempts: 3 });

    const events = await collect(rt.execute({ prompt: 'do it' }));

    expect(doneContent(events)).toBe('fixed'); // accepted attempt surfaces
    expect(seenPrompts).toHaveLength(2); // retried once
    expect(seenPrompts[1]).toContain('do it'); // original prompt kept
    expect(seenPrompts[1]).toContain('must say fixed'); // feedback injected
    // rejected attempt's content must NOT leak as a done event
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('returns last attempt when all fail within maxAttempts', async () => {
    const { factory, seenPrompts } = scriptedRuntimeFactory(['a', 'b', 'c', 'd']);
    const grader = createRubricGrader(() => ({ pass: false, score: 0 }));
    const rt = createVerifiedRuntime(factory, grader, { maxAttempts: 2 });

    const events = await collect(rt.execute({ prompt: 'do it' }));

    expect(seenPrompts).toHaveLength(2); // capped at maxAttempts
    expect(doneContent(events)).toBe('b'); // last attempt's output surfaces
  });

  it('fail-open: grader throwing does not break the agent', async () => {
    const { factory } = scriptedRuntimeFactory(['answer']);
    const grader = createRubricGrader(() => {
      throw new Error('judge down');
    });
    const rt = createVerifiedRuntime(factory, grader, { maxAttempts: 3, failOpen: true });

    const events = await collect(rt.execute({ prompt: 'do it' }));

    expect(doneContent(events)).toBe('answer');
  });

  it('abort between attempts prevents the next retry from starting', async () => {
    const { factory, seenPrompts } = scriptedRuntimeFactory(['bad', 'would retry']);
    let gradeStarted!: () => void;
    let finishGrade!: (grade: GradeResult) => void;
    const gradeStartedPromise = new Promise<void>((resolve) => {
      gradeStarted = resolve;
    });
    const grader = createRubricGrader(async () => {
      gradeStarted();
      return new Promise<GradeResult>((resolve) => {
        finishGrade = resolve;
      });
    });
    const rt = createVerifiedRuntime(factory, grader, { maxAttempts: 2 });

    const collecting = collect(rt.execute({ prompt: 'do it' }));
    await gradeStartedPromise;
    rt.abort();
    finishGrade({ pass: false, score: 0, feedback: 'retry' });
    const events = await collecting;

    expect(events).toEqual([]);
    expect(seenPrompts).toEqual(['do it']);
  });
});
