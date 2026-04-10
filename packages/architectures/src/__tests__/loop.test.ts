import { describe, it, expect } from 'vitest';
import { createLoopArchitecture } from '../loop.js';
import { MockLLMProvider, makeServices } from './mock-llm.js';
import type { AgentEvent, RuntimeServices } from '@nexora/contracts';

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('LoopArchitecture', () => {
  it('stops when shouldStop returns true', async () => {
    const llm = new MockLLMProvider([
      { text: 'iter 1' },
      { text: 'iter 2' },
      { text: 'STOP' },
    ]);
    const services = makeServices(llm, new Map());

    const arch = createLoopArchitecture({
      shouldStop: (_i, content) => content === 'STOP',
      maxIterations: 10,
    });
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'work' }));

    const texts = events.filter(e => e.type === 'text');
    expect(texts).toHaveLength(3);
    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') expect(done.content).toBe('STOP');
  });

  it('respects maxIterations', async () => {
    const llm = new MockLLMProvider([
      { text: '1' },
      { text: '2' },
    ]);
    const services = makeServices(llm, new Map());

    const arch = createLoopArchitecture({
      shouldStop: () => false,
      maxIterations: 2,
    });
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'work' }));

    const texts = events.filter(e => e.type === 'text');
    expect(texts).toHaveLength(2);
  });

  // Fix #4c: delayMs sleep must honor signal.
  // Previously `await new Promise(r => setTimeout(r, delayMs))` ignored abort,
  // so a long delay between iterations would stretch the agent's lifetime
  // well past an explicit cancellation.
  it('abortable sleep between iterations terminates on signal abort', async () => {
    const llm = new MockLLMProvider([
      { text: '1' },
      { text: '2' },
      { text: '3' },
    ]);
    const ac = new AbortController();
    const services = makeServices(llm, new Map(), ac.signal);

    const arch = createLoopArchitecture({
      shouldStop: () => false,
      maxIterations: 10,
      delayMs: 10_000, // long — would dominate the test if not interrupted
    });

    const start = Date.now();
    const collector = collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'x' }));

    // Let the first iteration complete + enter the long sleep
    await new Promise(r => setTimeout(r, 30));
    ac.abort();
    await collector;
    const elapsed = Date.now() - start;

    // Without the fix, this would wait ~10 seconds.
    expect(elapsed).toBeLessThan(1000);
  });
});
