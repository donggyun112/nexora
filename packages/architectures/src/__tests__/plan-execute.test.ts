import { describe, it, expect } from 'vitest';
import { createPlanExecuteArchitecture } from '../plan-execute.js';
import { MockLLMProvider, makeServices } from './mock-llm.js';
import type { AgentEvent, RuntimeServices } from '@dongkseo/contracts';

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// services.tools.list() 가 옵션의 tools 를 노출하도록 mock 보강.
function servicesWithToolList(llm: MockLLMProvider, tools: Map<string, (i: unknown) => Promise<unknown>>, listNames: string[]) {
  const services = makeServices(llm, tools) as unknown as RuntimeServices;
  services.tools = {
    ...services.tools,
    list: () => listNames.map(name => ({ name, description: name, parameters: {} })),
  };
  return services;
}

describe('PlanExecuteArchitecture — plan-mode gating', () => {
  it('hides execute-phase tools until the plan is submitted, then reveals them', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 'r1', name: 'web_search', arguments: { q: 'landscape' } }] }, // plan: research
      { text: '', toolCalls: [{ id: 'p1', name: 'submit_research_plan', arguments: { plan: '...' } }] }, // exit plan
      { text: '', toolCalls: [{ id: 's1', name: 'submit_keywords', arguments: { k: 1 } }] }, // execute: finalize
      { text: 'finalized' },
    ]);
    const tools = new Map<string, (i: unknown) => Promise<unknown>>([
      ['web_search', async () => ({ type: 'text' as const, text: 'results' })],
      ['submit_research_plan', async () => ({ type: 'text' as const, text: 'plan recorded' })],
      ['submit_keywords', async () => ({ type: 'text' as const, text: 'submitted' })],
    ]);
    const services = servicesWithToolList(llm, tools, ['web_search', 'submit_research_plan', 'submit_keywords']);

    const arch = createPlanExecuteArchitecture({
      exitPlanTool: 'submit_research_plan',
      executePhaseTools: ['submit_keywords'],
    });
    const events = await collect(arch.loop(services, { prompt: 'find keywords' }));

    // turn 1 (PLAN): submit_keywords must be HIDDEN, submit_research_plan visible
    const planToolNames = llm.callLog[0].options?.tools?.map((t: { name: string }) => t.name) ?? [];
    expect(planToolNames).toContain('web_search');
    expect(planToolNames).toContain('submit_research_plan');
    expect(planToolNames).not.toContain('submit_keywords');

    // turn 3 (EXECUTE, after plan submitted): submit_keywords REVEALED, exit tool hidden
    const execToolNames = llm.callLog[2].options?.tools?.map((t: { name: string }) => t.name) ?? [];
    expect(execToolNames).toContain('submit_keywords');
    expect(execToolNames).not.toContain('submit_research_plan');

    // transition progress + completion
    expect(events.some(e => e.type === 'progress')).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
  });

  it('surfaces response.thinking as a thinking event, before the text', async () => {
    const llm = new MockLLMProvider([
      { text: 'planning now', thinking: 'let me scout the landscape first' },
    ]);
    const services = servicesWithToolList(llm, new Map(), ['web_search', 'submit_research_plan', 'submit_keywords']);

    const arch = createPlanExecuteArchitecture({
      exitPlanTool: 'submit_research_plan',
      executePhaseTools: ['submit_keywords'],
    });
    const events = await collect(arch.loop(services, { prompt: 'go' }));

    const thinkingIdx = events.findIndex(e => e.type === 'thinking' && e.content === 'let me scout the landscape first');
    const textIdx = events.findIndex(e => e.type === 'text');
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(thinkingIdx); // thinking surfaces above the text
  });

  it('injects the plan instruction into the first user turn', async () => {
    const llm = new MockLLMProvider([{ text: 'thinking about plan' }]);
    const services = servicesWithToolList(llm, new Map(), ['web_search', 'submit_research_plan', 'submit_keywords']);

    const arch = createPlanExecuteArchitecture({
      exitPlanTool: 'submit_research_plan',
      executePhaseTools: ['submit_keywords'],
      planPrompt: 'PLAN_INSTRUCTION',
    });
    await collect(arch.loop(services, { prompt: 'go' }));

    const userMsg = llm.callLog[0].messages.find(m => m.role === 'user');
    const text = typeof userMsg?.content === 'string' ? userMsg.content : JSON.stringify(userMsg?.content);
    expect(text).toContain('go');
    expect(text).toContain('PLAN_INSTRUCTION');
  });

  it('resume starts directly in EXECUTE phase (execute tools available)', async () => {
    const llm = new MockLLMProvider([{ text: 'resumed and done' }]);
    const services = servicesWithToolList(llm, new Map(), ['web_search', 'submit_research_plan', 'submit_keywords']);

    const arch = createPlanExecuteArchitecture({
      exitPlanTool: 'submit_research_plan',
      executePhaseTools: ['submit_keywords'],
    });
    await collect(arch.loop(services, {
      prompt: '',
      resumeContext: {
        architectureHistory: [{ role: 'user', content: 'orig' }],
        resumedCallId: 'c1',
        toolResult: { type: 'text', text: 'yes' },
      },
    }));

    const toolNames = llm.callLog[0].options?.tools?.map((t: { name: string }) => t.name) ?? [];
    expect(toolNames).toContain('submit_keywords'); // execute phase on resume
  });

  it('continuation turn (prior history present) starts in EXECUTE, not PLAN', async () => {
    const llm = new MockLLMProvider([{ text: 'continuing work' }]);
    const services = servicesWithToolList(llm, new Map(), ['web_search', 'submit_research_plan', 'submit_keywords']);

    const arch = createPlanExecuteArchitecture({
      exitPlanTool: 'submit_research_plan',
      executePhaseTools: ['submit_keywords'],
    });
    // 부활/후속 turn: 이전 대화 history 가 실려온다 (plan 은 이전 turn 에 이미 제출).
    const events = await collect(arch.loop(services, {
      prompt: '에이전틱 ai로 발행',
      history: [
        { role: 'user', content: 'find keywords' },
        { role: 'assistant', content: [{ type: 'tool_call', id: 'p1', name: 'submit_research_plan', arguments: {} }] },
        { role: 'tool_result', content: [{ type: 'tool_result', id: 'p1', content: 'plan recorded', isError: false }] },
        { role: 'assistant', content: 'keyword slate ready' },
      ],
    }));

    const firstCallTools = llm.callLog[0].options?.tools?.map((t: { name: string }) => t.name) ?? [];
    expect(firstCallTools).toContain('submit_keywords');          // execute 도구 노출
    expect(firstCallTools).not.toContain('submit_research_plan');  // plan 종료 도구 숨김

    // plan prompt 미주입 — 후속 turn user 메시지에 PLAN 지시문이 붙으면 안 된다.
    const lastUser = llm.callLog[0].messages.filter(m => m.role === 'user').pop();
    const userText = typeof lastUser?.content === 'string' ? lastUser!.content : JSON.stringify(lastUser?.content);
    expect(userText).not.toContain('PLAN');

    expect(events.some(e => e.type === 'done')).toBe(true);
  });
});
