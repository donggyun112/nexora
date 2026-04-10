import { describe, it, expect } from 'vitest';
import { createPlanExecuteArchitecture } from '../plan-execute.js';
import { MockLLMProvider, makeServices } from './mock-llm.js';
import type { AgentEvent, RuntimeServices } from '@nexora/contracts';

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('PlanExecuteArchitecture', () => {
  it('plans then executes each step', async () => {
    const llm = new MockLLMProvider([
      // plan
      { text: '1. read the file\n2. summarize it' },
      // step 1
      { text: 'reading...' },
      // step 2
      { text: 'summary: hello' },
    ]);
    const services = makeServices(llm, new Map());

    const arch = createPlanExecuteArchitecture();
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'process' }));

    const progress = events.filter(e => e.type === 'progress');
    expect(progress.length).toBeGreaterThan(0);

    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') {
      expect(done.content).toContain('read the file');
      expect(done.content).toContain('summarize it');
    }
  });

  it('handles tool calls within a step', async () => {
    const llm = new MockLLMProvider([
      // plan
      { text: '1. echo hello' },
      // step 1 — calls a tool
      {
        text: 'calling echo',
        toolCalls: [{ id: 't1', name: 'echo', arguments: { msg: 'hello' } }],
      },
    ]);
    const tools = new Map([
      ['echo', async (input: unknown) => ({
        type: 'text' as const,
        text: `echoed ${(input as { msg: string }).msg}`,
      })],
    ]);
    const services = makeServices(llm, tools);

    const arch = createPlanExecuteArchitecture();
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    const toolCall = events.find(e => e.type === 'tool_call');
    expect(toolCall).toBeDefined();
    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
  });

  it('respects maxSteps cap', async () => {
    const llm = new MockLLMProvider([
      { text: '1. a\n2. b\n3. c\n4. d\n5. e' },
      { text: 'a done' },
      { text: 'b done' },
    ]);
    const services = makeServices(llm, new Map());

    const arch = createPlanExecuteArchitecture({ maxSteps: 2 });
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
  });
});
