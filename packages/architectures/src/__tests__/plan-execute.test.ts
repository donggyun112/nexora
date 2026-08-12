import { describe, it, expect } from 'vitest';
import { createPlanExecuteArchitecture } from '../plan-execute.js';
import { MockLLMProvider, makeServices } from './mock-llm.js';
import type { AgentEvent, PendingRuntimeInput, RuntimeServices, ToolDefinition } from '@dongkseo/contracts';
import { OrchestrationControlError } from '@dongkseo/contracts';

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
  it('does not convert an orchestration control signal into an agent error event', async () => {
    const control = new OrchestrationControlError('model effect is indeterminate');
    const llm = new MockLLMProvider([{ text: '' }]);
    llm.stream = async function* () { throw control; };
    const services = servicesWithToolList(llm, new Map(), ['submit_research_plan']);
    const arch = createPlanExecuteArchitecture({ exitPlanTool: 'submit_research_plan' });

    await expect(collect(arch.loop(services, { prompt: 'go' }))).rejects.toBe(control);
  });

  it('applies the PLAN prompt while admitting an orchestrated initial input', async () => {
    const llm = new MockLLMProvider([{ text: 'planning' }]);
    const services = servicesWithToolList(llm, new Map(), ['submit_research_plan']);
    const queued: PendingRuntimeInput = {
      kind: 'user_prompt',
      originId: 'input-1',
      input: { prompt: 'queued prompt' },
    };
    let firstClaim = true;
    const admitted: PendingRuntimeInput[] = [];
    services.inputs = {
      submit: async input => input,
      claim: async () => firstClaim ? (firstClaim = false, [queued]) : [],
      admit: async inputs => { admitted.push(...inputs); },
      discard: async () => {},
    };
    const arch = createPlanExecuteArchitecture({
      exitPlanTool: 'submit_research_plan',
      planPrompt: 'PLAN_FROM_QUEUE',
    });

    await collect(arch.loop(services, { prompt: 'must not be appended directly' }));

    expect(llm.callLog[0].messages).toContainEqual({
      id: 'input-1',
      role: 'user',
      content: 'queued prompt\n\nPLAN_FROM_QUEUE',
    });
    expect(admitted).toEqual([queued]);
  });

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

  it('accumulates LLM usage across plan and execute phases', async () => {
    const llm = new MockLLMProvider([
      {
        text: 'plan',
        toolCalls: [{ id: 'p1', name: 'submit_research_plan', arguments: { plan: '...' } }],
        usage: { promptTokens: 10, completionTokens: 4, cachedTokens: 2 },
      },
      {
        text: 'final',
        usage: { promptTokens: 20, completionTokens: 8, cachedTokens: 1 },
      },
    ]);
    const tools = new Map<string, (i: unknown) => Promise<unknown>>([
      ['submit_research_plan', async () => ({ type: 'text' as const, text: 'plan recorded' })],
    ]);
    const services = servicesWithToolList(llm, tools, ['submit_research_plan']);
    const arch = createPlanExecuteArchitecture({
      exitPlanTool: 'submit_research_plan',
      model: 'mock-model',
    });

    const events = await collect(arch.loop(services, { prompt: 'go' }));
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done');

    expect(done?.usage).toEqual({ promptTokens: 30, completionTokens: 12, cachedTokens: 3 });
    expect(done?.model).toBe('mock-model');
  });
});

describe('PlanExecuteArchitecture — round-end termination', () => {
  const researchLLM = () => new MockLLMProvider([
    { text: 'researching', toolCalls: [{ id: 'r1', name: 'web_search', arguments: { q: 'x' } }] },
    { text: 'still going' },
  ]);
  const researchTools = () => new Map<string, (i: unknown) => Promise<unknown>>([
    ['web_search', async () => ({ type: 'text' as const, text: 'results' })],
  ]);

  it('ends the run when shouldStopAfterTurn returns true', async () => {
    const llm = researchLLM();
    const services = servicesWithToolList(llm, researchTools(), ['web_search']);
    services.shouldStopAfterTurn = () => true;

    const events = await collect(createPlanExecuteArchitecture({ exitPlanTool: 'submit_plan' }).loop(services, { prompt: 'go' }));

    expect(llm.callLog).toHaveLength(1);
    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') expect(done.content).toBe('researching');
  });

  it('ends the run after a terminating tool succeeds', async () => {
    const llm = new MockLLMProvider([
      { text: 'wrapping up', toolCalls: [{ id: 's1', name: 'submit_keywords', arguments: {} }] },
      { text: 'should never be reached' },
    ]);
    const tools = new Map<string, (i: unknown) => Promise<unknown>>([
      ['submit_keywords', async () => ({ type: 'text' as const, text: 'submitted' })],
    ]);
    const services = servicesWithToolList(llm, tools, ['submit_keywords']);
    const submitDefinition: ToolDefinition = {
      name: 'submit_keywords',
      description: 'submit',
      parameters: {},
      terminatesLoop: true,
      execute: async () => ({ type: 'text', text: 'submitted' }),
    };
    services.tools.get = name => (name === 'submit_keywords' ? submitDefinition : undefined);

    const events = await collect(createPlanExecuteArchitecture({
      exitPlanTool: 'submit_plan',
      executePhaseTools: [],
    }).loop(services, { prompt: 'go' }));

    expect(llm.callLog).toHaveLength(1);
    expect(events.filter(e => e.type === 'tool_result')).toHaveLength(1);
    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') expect(done.content).toBe('wrapping up');
  });

  it('keeps looping when neither path fires (기존 동작 유지)', async () => {
    const llm = researchLLM();
    const services = servicesWithToolList(llm, researchTools(), ['web_search']);

    const events = await collect(createPlanExecuteArchitecture({ exitPlanTool: 'submit_plan' }).loop(services, { prompt: 'go' }));

    expect(llm.callLog).toHaveLength(2);
    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') expect(done.content).toBe('still going');
  });
});
