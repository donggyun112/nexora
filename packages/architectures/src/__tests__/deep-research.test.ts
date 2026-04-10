import { describe, it, expect } from 'vitest';
import { createDeepResearchArchitecture } from '../deep-research.js';
import { MockLLMProvider, makeServices } from './mock-llm.js';
import type { AgentEvent, RuntimeServices } from '@nexora/contracts';

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('DeepResearchArchitecture', () => {
  it('runs full Plan → Research → Evaluate(complete) → Compose', async () => {
    const llm = new MockLLMProvider([
      // plan
      { text: '1. who is X\n2. what did X do' },
      // research query 1
      { text: 'X is a person' },
      // research query 2
      { text: 'X did things' },
      // evaluation
      { text: '{"grade": "complete", "comment": "ok", "followUpQueries": []}' },
      // compose
      { text: '# Report\n\nFindings...' },
    ]);
    const services = makeServices(llm, new Map());

    const arch = createDeepResearchArchitecture();
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'who is X' }));

    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') expect(done.content).toContain('Report');
  });

  it('iterates research when evaluation is incomplete', async () => {
    const llm = new MockLLMProvider([
      // plan
      { text: '1. q1' },
      // research q1
      { text: 'partial answer' },
      // evaluation: incomplete with followups
      { text: '{"grade": "incomplete", "comment": "need more", "followUpQueries": ["q1-followup"]}' },
      // research followup
      { text: 'better answer' },
      // evaluation: complete
      { text: '{"grade": "complete", "comment": "ok", "followUpQueries": []}' },
      // compose
      { text: '# Report' },
    ]);
    const services = makeServices(llm, new Map());

    const arch = createDeepResearchArchitecture({ maxResearchIterations: 3 });
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'q' }));

    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
  });
});
