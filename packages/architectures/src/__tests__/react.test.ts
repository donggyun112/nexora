import { describe, it, expect, vi } from 'vitest';
import { createReactArchitecture } from '../react.js';
import { MockLLMProvider, makeServices } from './mock-llm.js';
import type { AgentEvent, PendingRuntimeInput, RuntimeServices, LLMMessage, StopReason, SuspendRequest, ToolBatchCall, ToolContext, ToolDefinition, ToolResult } from '@dongkseo/contracts';
import {
  OrchestrationControlError,
  continueDecision,
  denyDecision,
  errorResult,
  haltDecision,
  proceedDecision,
  suspendDecision,
  suspendResult,
} from '@dongkseo/contracts';

/** 게이트가 돌려주는 질문. 데이터일 뿐 — 아무것도 발행되지 않는다. */
const ASK: SuspendRequest = {
  topic: 'handraise.human.default',
  payload: { question: 'Approve: rm -rf /tmp/x' },
};

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('ReactArchitecture', () => {
  it('claims and admits an orchestrated prompt at the model boundary', async () => {
    const llm = new MockLLMProvider([{ text: 'queued response' }]);
    const services = makeServices(llm, new Map()) as unknown as RuntimeServices;
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

    const arch = createReactArchitecture();
    await collect(arch.loop(services, { prompt: 'must not be appended directly' }));

    expect(llm.callLog[0].messages.filter(message => message.role === 'user')).toEqual([
      { id: 'input-1', role: 'user', content: 'queued prompt' },
    ]);
    expect(admitted).toEqual([queued]);
  });

  it('completes immediately when no tool calls', async () => {
    const llm = new MockLLMProvider([{ text: 'hello world' }]);
    const services = makeServices(llm, new Map());

    const arch = createReactArchitecture();
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'hi' }));

    const types = events.map(e => e.type);
    expect(types).toContain('text');
    expect(types).toContain('done');
    expect(types).not.toContain('tool_call');

    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') expect(done.content).toBe('hello world');
  });

  it('runs tool then continues', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 't1', name: 'echo', arguments: { msg: 'hi' } }] },
      { text: 'I echoed your message' },
    ]);
    const tools = new Map([
      ['echo', async (input: unknown) => ({
        type: 'text' as const,
        text: `echoed: ${(input as { msg: string }).msg}`,
      })],
    ]);
    const services = makeServices(llm, tools);

    const arch = createReactArchitecture();
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'echo hi' }));

    const types = events.map(e => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('done');

    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') {
      expect(done.content).toBe('I echoed your message');
      expect(done.toolCalls).toHaveLength(1);
    }
  });

  it('prepares dynamic tools and injects tool context only after invocation', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 's1', name: 'skill', arguments: { skill: 'review' } }] },
      { text: 'followed skill' },
    ]);
    const services = makeServices(llm, new Map([
      ['skill', async () => ({
        type: 'text' as const,
        text: 'Loaded skill review.',
        contextMessages: [{
          content: 'FOLLOW THIS PROCEDURE',
          metadata: { kind: 'skill', name: 'review' },
        }],
      })],
    ])) as unknown as RuntimeServices;
    const prepared: LLMMessage[][] = [];
    services.tools.prepare = async messages => { prepared.push(structuredClone(messages)); };

    await collect(createReactArchitecture().loop(services, { prompt: 'review this' }));

    expect(prepared).toHaveLength(2);
    expect(JSON.stringify(prepared[0])).not.toContain('FOLLOW THIS PROCEDURE');
    expect(prepared[1]).toContainEqual({
      role: 'user',
      content: 'FOLLOW THIS PROCEDURE',
      metadata: { kind: 'skill', name: 'review' },
    });
  });

  it('passes image tool results back as multimodal context', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 't1', name: 'recall_image', arguments: { image_id: 'img_1_0.png' } }] },
      { text: 'I can see the image' },
    ]);
    const tools = new Map([
      ['recall_image', async () => ({
        type: 'image' as const,
        data: 'abc123',
        mimeType: 'image/png',
      })],
    ]);
    const services = makeServices(llm, tools);

    const arch = createReactArchitecture();
    await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'load it' }));

    const secondCall = llm.callLog[1];
    expect(secondCall).toBeDefined();
    const imageMessage = secondCall.messages.find(
      (msg) => Array.isArray(msg.content) && msg.content.some((block) => block.type === 'image'),
    );
    expect(imageMessage).toBeDefined();
    if (imageMessage && Array.isArray(imageMessage.content)) {
      expect(imageMessage.content).toContainEqual({ type: 'image', data: 'abc123', mimeType: 'image/png' });
    }
  });

  it('inlines text input files into the user prompt', async () => {
    const llm = new MockLLMProvider([{ text: 'ok' }]);
    const services = makeServices(llm, new Map());

    const arch = createReactArchitecture();
    await collect(arch.loop(services as unknown as RuntimeServices, {
      prompt: 'summarize',
      files: [{
        type: 'file',
        name: 'note.txt',
        mimeType: 'text/plain',
        data: Buffer.from('hello from file').toString('base64'),
        size: 15,
      }],
    }));

    const userMessage = llm.callLog[0].messages.find(m => m.role === 'user');
    expect(typeof userMessage?.content).toBe('string');
    expect(userMessage?.content).toContain('summarize');
    expect(userMessage?.content).toContain('Attached files:');
    expect(userMessage?.content).toContain('hello from file');
  });

  it('runs multiple tool calls in one round', async () => {
    const llm = new MockLLMProvider([
      {
        text: '',
        toolCalls: [
          { id: 't1', name: 'echo', arguments: { msg: 'a' } },
          { id: 't2', name: 'echo', arguments: { msg: 'b' } },
        ],
      },
      { text: 'done with both' },
    ]);
    const tools = new Map([
      ['echo', async (input: unknown) => ({
        type: 'text' as const,
        text: (input as { msg: string }).msg,
      })],
    ]);
    const services = makeServices(llm, tools);

    const arch = createReactArchitecture();
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    const toolCalls = events.filter(e => e.type === 'tool_call');
    const toolResults = events.filter(e => e.type === 'tool_result');
    expect(toolCalls).toHaveLength(2);
    expect(toolResults).toHaveLength(2);
  });

  it('delegates tool-call batches to the executor policy when available', async () => {
    const llm = new MockLLMProvider([
      {
        text: '',
        toolCalls: [
          { id: 't1', name: 'echo', arguments: { msg: 'a' } },
          { id: 't2', name: 'echo', arguments: { msg: 'b' } },
        ],
      },
      { text: 'done with both' },
    ]);
    const services = makeServices(llm, new Map()) as unknown as RuntimeServices;
    let batchCalled = false;
    services.tools = {
      list: () => [{ name: 'echo', description: 'echo', parameters: {} }],
      execute: async () => {
        throw new Error('direct execute should not be called');
      },
      executeBatch: async (calls) => {
        batchCalled = true;
        return calls.map(call => ({
          callId: call.callId,
          name: call.name,
          result: { type: 'text' as const, text: (call.input as { msg: string }).msg },
          isError: false,
        }));
      },
    };

    const arch = createReactArchitecture();
    const events = await collect(arch.loop(services, { prompt: 'go' }));

    expect(batchCalled).toBe(true);
    expect(events.filter(e => e.type === 'tool_result')).toHaveLength(2);
  });

  it('runs tool calls sequentially when the executor has no batch policy', async () => {
    const llm = new MockLLMProvider([
      {
        text: '',
        toolCalls: [
          { id: 't1', name: 'a', arguments: {} },
          { id: 't2', name: 'b', arguments: {} },
        ],
      },
      { text: 'done with both' },
    ]);
    let active = 0;
    let peak = 0;
    const tracked = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 20));
      active--;
      return { type: 'text' as const, text: 'ok' };
    };
    const tools = new Map([
      ['a', tracked],
      ['b', tracked],
    ]);
    const services = makeServices(llm, tools);

    const arch = createReactArchitecture();
    await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(peak).toBe(1);
  });

  it('emits error on LLM throw', async () => {
    const llm = new MockLLMProvider([{ text: '', throwError: 'llm fail' }]);
    const services = makeServices(llm, new Map());
    const arch = createReactArchitecture();
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'x' }));
    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined();
    if (err?.type === 'error') expect(err.message).toContain('llm fail');
  });

  it('does not convert an orchestration control signal into an agent error event', async () => {
    const control = new OrchestrationControlError('model effect is indeterminate');
    const llm = new MockLLMProvider([{ text: '' }]);
    llm.stream = async function* () { throw control; };
    const services = makeServices(llm, new Map());
    const arch = createReactArchitecture();

    await expect(collect(arch.loop(
      services as unknown as RuntimeServices,
      { prompt: 'x' },
    ))).rejects.toBe(control);
  });

  it('respects maxIterations', async () => {
    // Always returns a tool call → infinite loop unless maxIterations stops it
    const responses = Array.from({ length: 5 }, () => ({
      text: '',
      toolCalls: [{ id: 't', name: 'noop', arguments: {} }],
    }));
    const llm = new MockLLMProvider(responses);
    const tools = new Map([
      ['noop', async () => ({ type: 'text' as const, text: 'ok' })],
    ]);
    const services = makeServices(llm, tools);

    const arch = createReactArchitecture({ maxIterations: 3 });
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    const toolCalls = events.filter(e => e.type === 'tool_call');
    expect(toolCalls.length).toBe(3); // exactly 3 iterations
    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
  });

  it('normal path never calls memory.append', async () => {
    const appendSpy = vi.fn();
    const llm = new MockLLMProvider([{ text: 'done', toolCalls: [] }]);
    const tools = new Map<string, (input: unknown) => Promise<unknown>>();
    const services = makeServices(llm, tools, {
      memory: {
        append: appendSpy,
        getHistory: async () => [],
        compact: async () => null,
        clear: async () => {},
      },
    });
    const react = createReactArchitecture();
    await collect(react.loop(services as unknown as RuntimeServices, { prompt: 'hello' }));
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it('seeds rich history (tool blocks) from memory.getHistory into the LLM call', async () => {
    const richHistory: LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: 'FILE', isError: false }] },
    ];
    const llm = new MockLLMProvider([{ text: 'done', toolCalls: [] }]);
    const tools = new Map<string, (input: unknown) => Promise<unknown>>();
    const services = makeServices(llm, tools, {
      memory: { append: async () => {}, getHistory: async () => richHistory, compact: async () => null, clear: async () => {} },
    });
    const react = createReactArchitecture();
    await collect(react.loop(services as unknown as RuntimeServices, { prompt: 'go' }));
    const firstMessages = llm.callLog[0].messages;
    // the two rich history messages appear (in order) before the current user prompt
    expect(firstMessages).toContainEqual(richHistory[0]);
    expect(firstMessages).toContainEqual(richHistory[1]);
    const userIdx = firstMessages.findIndex(m => m.role === 'user');
    const richAsstIdx = firstMessages.indexOf(richHistory[0]);
    const richToolIdx = firstMessages.indexOf(richHistory[1]);
    expect(richAsstIdx).toBeGreaterThanOrEqual(0);
    expect(richToolIdx).toBeGreaterThan(richAsstIdx);
    expect(richToolIdx).toBeLessThan(userIdx);
  });
});

describe('ReAct suspend', () => {
  it('terminates with suspended event when tool returns suspend', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 'call-1', name: 'ask', arguments: {} }] },
    ]);
    const tools = new Map([
      ['ask', async () => suspendResult('pending-xyz')],
    ]);
    const onSuspendCalls: { pendingId: string; toolCallId: string; historyLen: number }[] = [];
    const services = makeServices(llm, tools, {
      onSuspend: async ({ pendingId, toolCallId, architectureHistory }) => {
        onSuspendCalls.push({ pendingId, toolCallId, historyLen: architectureHistory.length });
      },
    });

    const arch = createReactArchitecture();
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'q' }));
    const suspended = events.find(e => e.type === 'suspended');

    expect(suspended).toEqual({ type: 'suspended', pendingId: 'pending-xyz', toolCallId: 'call-1' });
    expect(events.some(e => e.type === 'done')).toBe(false);
    expect(onSuspendCalls).toHaveLength(1);
    expect(onSuspendCalls[0]).toMatchObject({ pendingId: 'pending-xyz', toolCallId: 'call-1' });
    expect(onSuspendCalls[0].historyLen).toBeGreaterThan(0);
  });

  it('runs an exclusive suspending tool before the rest of a mixed batch', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [
        { id: 'call-1', name: 'write_file', arguments: { path: 'out.txt' } },
        { id: 'call-2', name: 'ask', arguments: {} },
      ]},
    ]);
    let writeRan = false;
    const tools = new Map<string, (input: unknown) => Promise<unknown>>([
      ['write_file', async () => {
        writeRan = true;
        return { type: 'text' as const, text: 'written' };
      }],
      ['ask', async () => suspendResult('p1')],
    ]);
    let checkpoint: Parameters<NonNullable<RuntimeServices['onSuspend']>>[0] | undefined;
    const services = makeServices(llm, tools, {
      onSuspend: async (info) => {
        checkpoint = info;
      },
    }) as unknown as RuntimeServices;
    const executedBatches: string[][] = [];
    services.tools.executeBatch = async (calls) => {
      executedBatches.push(calls.map(call => call.callId));
      return [{
        callId: calls[0].callId,
        name: calls[0].name,
        result: suspendResult('p1'),
        isError: false,
      }];
    };
    const askDefinition: ToolDefinition = {
      name: 'ask',
      description: 'ask',
      parameters: {},
      isExclusive: true,
      execute: async () => suspendResult('p1'),
    };
    services.tools.get = name => name === 'ask' ? askDefinition : undefined;

    const arch = createReactArchitecture();
    const events = await collect(arch.loop(services, { prompt: 'q' }));

    expect(writeRan).toBe(false);
    expect(executedBatches).toEqual([['call-2']]);
    expect(events.filter(e => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', id: 'call-2', name: 'ask', input: {} },
    ]);
    expect(events.some(e => e.type === 'suspended' && (e as { type: 'suspended'; pendingId: string }).pendingId === 'p1')).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(false);
    expect(checkpoint?.completedResults).toEqual([]);
    const assistant = checkpoint?.architectureHistory.find(message => message.role === 'assistant');
    expect(assistant?.content).toEqual([
      { type: 'tool_call', id: 'call-2', name: 'ask', arguments: {} },
    ]);
  });

  it('checkpoints completed results and restores them beside the resumed result', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [
        { id: 'call-1', name: 'echo', arguments: {} },
        { id: 'call-2', name: 'ask', arguments: {} },
      ]},
    ]);
    const tools = new Map<string, (input: unknown) => Promise<unknown>>([
      ['echo', async () => ({ type: 'text' as const, text: 'echoed' })],
      ['ask', async () => suspendResult('p1')],
    ]);
    let checkpoint: Parameters<NonNullable<RuntimeServices['onSuspend']>>[0] | undefined;
    const services = makeServices(llm, tools, {
      onSuspend: async (info) => {
        checkpoint = info;
      },
    }) as unknown as RuntimeServices;
    services.tools.executeBatch = async (calls) => Promise.all(calls.map(async (call) => {
      const result = await tools.get(call.name)!(call.input) as ToolResult;
      return {
        callId: call.callId,
        name: call.name,
        result,
        isError: result.type === 'error',
      };
    }));

    const arch = createReactArchitecture();
    const events = await collect(arch.loop(services, { prompt: 'q' }));

    expect(events.filter(e => e.type === 'tool_result').map(e => e.id)).toEqual([
      'call-1',
      'call-2',
    ]);
    expect(checkpoint?.completedResults).toEqual([
      { type: 'tool_result', id: 'call-1', content: 'echoed', isError: false },
    ]);
    const assistant = checkpoint?.architectureHistory.find(message => message.role === 'assistant');
    expect(assistant?.content).toEqual([
      { type: 'tool_call', id: 'call-1', name: 'echo', arguments: {} },
      { type: 'tool_call', id: 'call-2', name: 'ask', arguments: {} },
    ]);

    const resumedLlm = new MockLLMProvider([{ text: 'done', toolCalls: [] }]);
    const resumedServices = makeServices(resumedLlm, new Map());
    await collect(arch.loop(resumedServices as unknown as RuntimeServices, {
      prompt: '',
      resumeContext: {
        architectureHistory: checkpoint!.architectureHistory,
        completedResults: checkpoint!.completedResults,
        resumedCallId: checkpoint!.toolCallId,
        toolResult: { type: 'text', text: 'approved' },
      },
    }));

    const restored = resumedLlm.callLog[0].messages.find(message => message.role === 'tool_result');
    expect(restored?.content).toEqual([
      { type: 'tool_result', id: 'call-1', content: 'echoed', isError: false },
      { type: 'tool_result', id: 'call-2', content: 'approved', isError: false },
    ]);
  });
});

describe('ReAct resume', () => {
  it('seeds history from resumeContext and injects tool_result before next LLM turn', async () => {
    const llm = new MockLLMProvider([
      { text: 'final answer based on user reply', toolCalls: [] },
    ]);
    const tools = new Map<string, (input: unknown) => Promise<unknown>>();
    const services = makeServices(llm, tools);

    const savedHistory: LLMMessage[] = [
      { role: 'user', content: 'original prompt' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'call-1', name: 'ask', arguments: { q: 'go?' } },
        ],
      },
    ];

    const react = createReactArchitecture();
    const events = await collect(react.loop(services as unknown as RuntimeServices, {
      prompt: '',
      resumeContext: {
        architectureHistory: savedHistory,
        resumedCallId: 'call-1',
        toolResult: { type: 'text', text: 'yes' },
      },
    }));

    const done = events.find(e => e.type === 'done');
    expect(done).toMatchObject({ type: 'done', content: 'final answer based on user reply' });

    // verify LLM saw the seeded history + injected tool_result
    const lastCallMessages = llm.callLog[0].messages;
    // assistant tool_call message preserved
    expect(lastCallMessages).toContainEqual(savedHistory[1]);
    // tool_result for resumed call present
    expect(lastCallMessages.find((m: LLMMessage) =>
      m.role === 'tool_result' &&
      Array.isArray(m.content) &&
      (m.content as any[]).some((c: any) => c.type === 'tool_result' && c.id === 'call-1' && c.content === 'yes')
    )).toBeTruthy();
  });

  it('resume path does not call memory.append', async () => {
    const llm = new MockLLMProvider([
      { text: 'ok', toolCalls: [] },
    ]);
    const tools = new Map<string, (input: unknown) => Promise<unknown>>();
    const memoryAppends: any[] = [];
    const services = makeServices(llm, tools, {
      memory: {
        append: async (msg: any) => { memoryAppends.push(msg); },
        getHistory: async () => [],
        compact: async () => null,
        clear: async () => {},
      },
    });

    const react = createReactArchitecture();
    await collect(react.loop(services as unknown as RuntimeServices, {
      prompt: '',
      resumeContext: {
        architectureHistory: [{ role: 'user', content: 'orig' }],
        resumedCallId: 'c1',
        toolResult: { type: 'text', text: 'yes' },
      },
    }));

    // On resume, no user message should be appended to memory (it was appended on original execution).
    expect(memoryAppends.some((m: any) => m.role === 'user')).toBe(false);
  });

  it('absorbs a mid-run steered message and continues instead of finishing', async () => {
    const llm = new MockLLMProvider([{ text: 'first' }, { text: 'second after steer' }]);
    const seenHistories: LLMMessage[][] = [];
    const origStream = llm.stream.bind(llm);
    (llm as any).stream = (history: LLMMessage[], opts: unknown) => {
      seenHistories.push([...history]);
      return origStream(history, opts as any);
    };

    // drainSteers 호출 순서: iter0-top(빈) → iter0-pre-done(steer) → iter1-top(빈) → iter1-pre-done(빈).
    let calls = 0;
    const services = makeServices(llm, new Map(), {
      drainSteers: () => {
        calls += 1;
        return calls === 2 ? [{ role: 'user', content: 'keep going' } as LLMMessage] : [];
      },
    });

    const arch = createReactArchitecture();
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'start' }));

    const done = events.find(e => e.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type === 'done') expect(done.content).toBe('second after steer'); // 끝내지 않고 이어감
    expect(seenHistories.length).toBe(2);                                       // 2번째 LLM 호출 발생
    // 2번째 호출 history 에 주입된 메시지가 합류해 있어야 한다.
    expect(seenHistories[1].some(m => m.role === 'user' && m.content === 'keep going')).toBe(true);
  });
});

describe('ReAct preToolUse', () => {
  const twoCallLLM = () => new MockLLMProvider([
    { text: '', toolCalls: [
      { id: 'call-1', name: 'echo', arguments: { msg: 'a' } },
      { id: 'call-2', name: 'echo', arguments: { msg: 'b' } },
    ]},
    { text: 'wrapped up' },
  ]);
  const countingTools = (ran: string[]) => new Map<string, (input: unknown) => Promise<unknown>>([
    ['echo', async (input) => {
      ran.push((input as { msg: string }).msg);
      return { type: 'text' as const, text: 'ok' };
    }],
  ]);

  it('runs every call untouched when the gate is unset', async () => {
    const ran: string[] = [];
    const services = makeServices(twoCallLLM(), countingTools(ran));

    const events = await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(ran).toEqual(['a', 'b']);
    expect(events.filter(e => e.type === 'tool_result')).toHaveLength(2);
  });

  it('is asked once per call with the executor context', async () => {
    const ran: string[] = [];
    const context = { tenantId: 't1' } as unknown as ToolContext;
    const seen: { name: string; callId: string; tenantId?: string }[] = [];
    const services = makeServices(twoCallLLM(), countingTools(ran), {
      preToolUse: async ({ call, context: ctx }) => {
        seen.push({ name: call.name, callId: call.callId, tenantId: ctx?.tenantId });
        return continueDecision();
      },
    }) as unknown as RuntimeServices;
    services.tools.getContext = () => context;

    await collect(createReactArchitecture().loop(services, { prompt: 'go' }));

    expect(seen).toEqual([
      { name: 'echo', callId: 'call-1', tenantId: 't1' },
      { name: 'echo', callId: 'call-2', tenantId: 't1' },
    ]);
    expect(ran).toEqual(['a', 'b']);
  });

  it('denies without touching the executor and shows the model the denial', async () => {
    const ran: string[] = [];
    const llm = twoCallLLM();
    const services = makeServices(llm, countingTools(ran), {
      preToolUse: async ({ call }) => call.callId === 'call-1'
        ? denyDecision(errorResult('denied by policy'))
        : continueDecision(),
    });

    const events = await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(ran).toEqual(['b']); // call-1 never reached the executor
    expect(events.filter(e => e.type === 'tool_result').map(e => ({ id: e.id, isError: e.isError }))).toEqual([
      { id: 'call-1', isError: true },
      { id: 'call-2', isError: false },
    ]);
    // 거부 결과가 다음 LLM 턴의 tool_result 로 모델에 보인다.
    const resultBlocks = llm.callLog[1].messages
      .filter(m => m.role === 'tool_result')
      .flatMap(m => m.content as { id: string; content: string }[]);
    expect(resultBlocks).toContainEqual({
      type: 'tool_result',
      id: 'call-1',
      content: '[ERROR] denied by policy',
      isError: true,
    });
  });

  it('does not let a denied terminating tool end the run', async () => {
    const llm = new MockLLMProvider([
      { text: 'submitting', toolCalls: [{ id: 't1', name: 'submit', arguments: {} }] },
      { text: 'recovered after denial' },
    ]);
    const services = makeServices(llm, new Map(), {
      preToolUse: async () => denyDecision(errorResult('not allowed')),
    }) as unknown as RuntimeServices;
    services.tools.get = () => ({
      name: 'submit',
      description: 'submit',
      parameters: {},
      terminatesLoop: true,
      execute: async () => ({ type: 'text', text: 'submitted' }),
    } as ToolDefinition);

    const events = await collect(createReactArchitecture().loop(services, { prompt: 'go' }));

    expect(llm.callLog).toHaveLength(2);
    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') expect(done.content).toBe('recovered after denial');
  });

  it('mints the pendingId itself and hands the gate request to onSuspend', async () => {
    const ran: string[] = [];
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 'call-1', name: 'echo', arguments: { msg: 'a' } }] },
    ]);
    let checkpoint: Parameters<NonNullable<RuntimeServices['onSuspend']>>[0] | undefined;
    const services = makeServices(llm, countingTools(ran), {
      preToolUse: async () => suspendDecision(ASK),
      onSuspend: async (info) => { checkpoint = info; },
    });

    const events = await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(ran).toEqual([]);
    const suspended = events.find(e => e.type === 'suspended');
    // 게이트는 id 를 만들지 않는다 — 루프가 만들고, 이벤트/체크포인트가 같은 값을 쓴다.
    expect(suspended).toMatchObject({ type: 'suspended', toolCallId: 'call-1' });
    const pendingId = (suspended as { pendingId: string }).pendingId;
    expect(pendingId).toBeTruthy();
    expect(events.some(e => e.type === 'done')).toBe(false);
    expect(checkpoint).toMatchObject({
      pendingId,
      toolCallId: 'call-1',
      call: { name: 'echo', input: { msg: 'a' } },
      // 발행은 파킹이 기록된 뒤 런타임 몫이므로 질문이 여기까지 실려온다.
      request: ASK,
    });
  });

  it('logs loudly when a gate parks but nothing is wired to persist or publish it', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 'call-1', name: 'echo', arguments: { msg: 'a' } }] },
    ]);
    const errors: { event: string; data?: unknown }[] = [];
    const services = makeServices(llm, countingTools([]), {
      preToolUse: async () => suspendDecision(ASK),
      // onSuspend 없음 — 승인 게이트를 달고 suspended-turn 저장소를 안 붙인 오설정.
      logger: {
        info: () => {}, warn: () => {}, debug: () => {},
        error: (event: string, data?: unknown) => { errors.push({ event, data }); },
      },
    });

    await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    // 조용히 넘어가면 "승인이 영영 안 온다"의 이유를 아무도 못 찾는다.
    expect(errors).toHaveLength(1);
    expect(errors[0].event).toBe('suspend.unhandled');
    expect(errors[0].data).toMatchObject({ toolCallId: 'call-1', topic: ASK.topic });
  });

  it('stays quiet when a tool suspended itself and nothing is wired', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 'call-1', name: 'ask', arguments: {} }] },
    ]);
    const errors: unknown[] = [];
    const services = makeServices(llm, new Map([['ask', async () => suspendResult('tool-p1')]]), {
      logger: {
        info: () => {}, warn: () => {}, debug: () => {},
        error: (event: string) => { errors.push(event); },
      },
    });

    await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    // 도구가 스스로 낸 suspend 는 질문을 이미 보냈다 — 예전부터 같은 상태였고 새 소음이 아니다.
    expect(errors).toEqual([]);
  });

  it('leaves request unset when the tool suspended itself', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [{ id: 'call-1', name: 'ask', arguments: {} }] },
    ]);
    let checkpoint: Parameters<NonNullable<RuntimeServices['onSuspend']>>[0] | undefined;
    const services = makeServices(llm, new Map([['ask', async () => suspendResult('tool-p1')]]), {
      onSuspend: async (info) => { checkpoint = info; },
    });

    await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    // 도구가 스스로 발행하고 낸 pendingId 라 런타임이 발행할 게 없다.
    expect(checkpoint?.pendingId).toBe('tool-p1');
    expect(checkpoint?.request).toBeUndefined();
  });

  it('does not start the calls after a gate suspend, and keeps the completed ones', async () => {
    const ran: string[] = [];
    const gated: string[] = [];
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [
        { id: 'call-1', name: 'echo', arguments: { msg: 'a' } },
        { id: 'call-2', name: 'echo', arguments: { msg: 'b' } },
        { id: 'call-3', name: 'echo', arguments: { msg: 'c' } },
      ]},
    ]);
    let checkpoint: Parameters<NonNullable<RuntimeServices['onSuspend']>>[0] | undefined;
    const services = makeServices(llm, countingTools(ran), {
      preToolUse: async ({ call }) => {
        gated.push(call.callId);
        return call.callId === 'call-2' ? suspendDecision(ASK) : continueDecision();
      },
      onSuspend: async (info) => { checkpoint = info; },
    });

    const events = await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(gated).toEqual(['call-1', 'call-2']); // call-3 은 묻지도 않는다
    expect(ran).toEqual(['a']);                  // call-3 은 시작되지 않는다
    expect(checkpoint?.request).toEqual(ASK);
    expect(events.find(e => e.type === 'suspended')).toMatchObject({
      toolCallId: 'call-2',
      pendingId: checkpoint!.pendingId,
    });
    // 이미 완료된 결과는 체크포인트에 보존된다.
    expect(checkpoint?.completedResults).toEqual([
      { type: 'tool_result', id: 'call-1', content: 'ok', isError: false },
    ]);
  });
});

describe('ReAct onResume', () => {
  const savedHistory = (): LLMMessage[] => [
    { role: 'user', content: 'delete the file' },
    {
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'call-1', name: 'rm', arguments: { path: 'a.txt' } }],
    },
  ];
  const resumeContext = () => ({
    architectureHistory: savedHistory(),
    resumedCallId: 'call-1',
    toolResult: { type: 'text' as const, text: 'approve' },
    resumedCall: { name: 'rm', input: { path: 'a.txt' } },
    resumeAnswer: { pendingId: 'p1', answer: 'approve' },
  });
  const rmTools = (ran: unknown[]) => new Map<string, (input: unknown) => Promise<unknown>>([
    ['rm', async (input) => {
      ran.push(input);
      return { type: 'text' as const, text: 'removed a.txt' };
    }],
  ]);

  it('injects the answer as the result when the hook is unset', async () => {
    const ran: unknown[] = [];
    const llm = new MockLLMProvider([{ text: 'done' }]);
    const services = makeServices(llm, rmTools(ran));

    await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, {
      prompt: '',
      resumeContext: resumeContext(),
    }));

    expect(ran).toEqual([]); // 도구 재실행 없음 — 기존 동작
    const blocks = llm.callLog[0].messages
      .filter(m => m.role === 'tool_result')
      .flatMap(m => m.content as { id: string; content: string }[]);
    expect(blocks).toEqual([
      { type: 'tool_result', id: 'call-1', content: 'approve', isError: false },
    ]);
  });

  it('runs the parked tool on continue and uses its result', async () => {
    const ran: unknown[] = [];
    const llm = new MockLLMProvider([{ text: 'file removed' }]);
    const seen: { name: string; answer: unknown }[] = [];
    const services = makeServices(llm, rmTools(ran), {
      onResume: async ({ call, resume }) => {
        seen.push({ name: call.name, answer: resume.answer });
        return continueDecision();
      },
    });

    const events = await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, {
      prompt: '',
      resumeContext: resumeContext(),
    }));

    expect(seen).toEqual([{ name: 'rm', answer: 'approve' }]);
    expect(ran).toEqual([{ path: 'a.txt' }]);
    expect(events.filter(e => e.type === 'tool_result')).toEqual([
      { type: 'tool_result', id: 'call-1', name: 'rm', result: { type: 'text', text: 'removed a.txt' }, isError: false },
    ]);
    const blocks = llm.callLog[0].messages
      .filter(m => m.role === 'tool_result')
      .flatMap(m => m.content as { id: string; content: string }[]);
    expect(blocks).toEqual([
      { type: 'tool_result', id: 'call-1', content: 'removed a.txt', isError: false },
    ]);
  });

  it('denies with the answer itself when the answer is an error, without asking policy', async () => {
    const ran: unknown[] = [];
    const llm = new MockLLMProvider([{ text: 'understood' }]);
    let asked = false;
    const services = makeServices(llm, rmTools(ran), {
      onResume: async () => {
        asked = true;
        return continueDecision();
      },
    });

    await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, {
      prompt: '',
      resumeContext: {
        ...resumeContext(),
        resumeAnswer: { pendingId: 'p1', answer: errorResult('approval channel unavailable') },
      },
    }));

    // 승인 채널이 죽은 것은 정책 판단 대상이 아니다. 게이트에 넘기면 "choice 가 없다"로
    // 읽혀 인프라 장애가 프로토콜 실수로 보고된다.
    expect(asked).toBe(false);
    expect(ran).toEqual([]);
    const blocks = llm.callLog[0].messages
      .filter(m => m.role === 'tool_result')
      .flatMap(m => m.content as { id: string; content: string; isError: boolean }[]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isError).toBe(true);
    expect(blocks[0].content).toContain('approval channel unavailable');
  });

  it('does not run the parked tool on deny and shows the denial instead', async () => {
    const ran: unknown[] = [];
    const llm = new MockLLMProvider([{ text: 'understood' }]);
    const services = makeServices(llm, rmTools(ran), {
      onResume: async () => denyDecision(errorResult('human refused')),
    });

    await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, {
      prompt: '',
      resumeContext: resumeContext(),
    }));

    expect(ran).toEqual([]);
    const blocks = llm.callLog[0].messages
      .filter(m => m.role === 'tool_result')
      .flatMap(m => m.content as { id: string; content: string }[]);
    expect(blocks).toEqual([
      { type: 'tool_result', id: 'call-1', content: '[ERROR] human refused', isError: true },
    ]);
  });

  it('re-parks on suspend through the existing suspend path', async () => {
    const ran: unknown[] = [];
    const llm = new MockLLMProvider([{ text: 'never reached' }]);
    let checkpoint: Parameters<NonNullable<RuntimeServices['onSuspend']>>[0] | undefined;
    const services = makeServices(llm, rmTools(ran), {
      onResume: async () => suspendDecision(ASK),
      onSuspend: async (info) => { checkpoint = info; },
    });

    const events = await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, {
      prompt: '',
      resumeContext: { ...resumeContext(), completedResults: [
        { type: 'tool_result', id: 'call-0', content: 'earlier', isError: false },
      ] },
    }));

    expect(ran).toEqual([]);
    expect(llm.callLog).toHaveLength(0); // 다음 LLM 턴 없이 다시 파킹
    // 재파킹도 같다 — 루프가 새 pendingId 를 만들고, 질문은 체크포인트에 실려 나간다.
    expect(checkpoint).toMatchObject({ toolCallId: 'call-1', call: { name: 'rm' }, request: ASK });
    expect(checkpoint!.pendingId).toBeTruthy();
    expect(events.find(e => e.type === 'suspended')).toEqual({
      type: 'suspended',
      pendingId: checkpoint!.pendingId,
      toolCallId: 'call-1',
    });
    expect(checkpoint?.completedResults).toEqual([
      { type: 'tool_result', id: 'call-0', content: 'earlier', isError: false },
    ]);
  });

  it('is not consulted when the checkpoint carries no original call', async () => {
    const ran: unknown[] = [];
    const llm = new MockLLMProvider([{ text: 'done' }]);
    const hook = vi.fn(async () => continueDecision());
    const services = makeServices(llm, rmTools(ran), { onResume: hook });

    await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, {
      prompt: '',
      resumeContext: {
        architectureHistory: savedHistory(),
        resumedCallId: 'call-1',
        toolResult: { type: 'text', text: 'approve' },
      },
    }));

    expect(hook).not.toHaveBeenCalled();
    expect(ran).toEqual([]);
  });

  it('re-executes through the executor without re-asking preToolUse', async () => {
    const ran: unknown[] = [];
    const llm = new MockLLMProvider([{ text: 'file removed' }]);
    const gate = vi.fn(async () => suspendDecision(ASK)); // 다시 물으면 영원히 재파킹
    const services = makeServices(llm, rmTools(ran), {
      onResume: async () => continueDecision(),
      preToolUse: gate,
    });

    await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, {
      prompt: '',
      resumeContext: resumeContext(),
    }));

    expect(gate).not.toHaveBeenCalled();
    expect(ran).toEqual([{ path: 'a.txt' }]);
  });
});

describe('ReAct within-turn compaction', () => {
  const PLACEHOLDER = '[older tool output pruned to fit context]';
  const compaction = { contextWindow: 2000, reserveTokens: 0, keepRecentTokens: 500, toolResultTruncateChars: 100 };
  const big = 'x'.repeat(6000);

  const makeLoopLLM = () => new MockLLMProvider([
    { text: '', toolCalls: [{ id: 't1', name: 'search', arguments: {} }] },
    { text: '', toolCalls: [{ id: 't2', name: 'search', arguments: {} }] },
    { text: 'done' },
  ]);
  const makeTools = () => new Map([['search', async () => ({ type: 'text' as const, text: big })]]);

  const placeholderInFinalHistory = (llm: MockLLMProvider): boolean => {
    const finalHistory = llm.callLog[llm.callLog.length - 1].messages;
    return finalHistory
      .filter(m => m.role === 'tool_result')
      .flatMap(m => m.content as { content: string }[])
      .some(b => b.content === PLACEHOLDER);
  };

  it('compaction 옵션이 있으면 한 턴 안에서 오래된 tool_result 를 프루닝한다', async () => {
    const llm = makeLoopLLM();
    const services = makeServices(llm, makeTools());
    const arch = createReactArchitecture({ compaction });
    await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(placeholderInFinalHistory(llm)).toBe(true);
  });

  it('compaction 옵션이 없으면 프루닝하지 않는다 (기존 동작 유지)', async () => {
    const llm = makeLoopLLM();
    const services = makeServices(llm, makeTools());
    const arch = createReactArchitecture();
    await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(placeholderInFinalHistory(llm)).toBe(false);
  });
});

describe('ReAct turn-level controls', () => {
  /** 라운드 0: 도구 호출 → 라운드 1: 텍스트로 종료. 훅이 없으면 LLM 이 2번 불린다. */
  const twoRoundLLM = () => new MockLLMProvider([
    { text: 'first turn', toolCalls: [{ id: 't1', name: 'echo', arguments: { n: 1 } }] },
    { text: 'second turn' },
  ]);
  const echoTools = () => new Map<string, (input: unknown) => Promise<unknown>>([
    ['echo', async () => ({ type: 'text' as const, text: 'ok' })],
  ]);

  it('훅이 전부 미설정이면 예전 동작 그대로다', async () => {
    const llm = twoRoundLLM();
    const services = makeServices(llm, echoTools());

    const events = await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(llm.callLog).toHaveLength(2);
    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') {
      expect(done.content).toBe('second turn');
      expect(done.toolCalls).toEqual([{ name: 'echo', input: { n: 1 } }]);
    }
  });

  it('beforeFinish 가 halt 면 종료하고 게이트가 받은 reason 은 바뀌지 않는다', async () => {
    const seen: StopReason[] = [];
    const llm = new MockLLMProvider([{ text: 'all done' }, { text: 'never reached' }]);
    const services = makeServices(llm, new Map(), {
      beforeFinish: async (_ctx, reason) => {
        seen.push(reason);
        return haltDecision(reason);
      },
    });

    const events = await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    // 도구 없이 끝난 실행이므로 게이트가 판정하는 이유는 'completed' 다. 루프가 그 이유를
    // 지어내지도, 게이트가 돌려준 것을 다시 쓰지도 않는다.
    expect(seen).toEqual(['completed']);
    expect(llm.callLog).toHaveLength(1);
    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') expect(done.content).toBe('all done');
  });

  it('beforeFinish 가 proceed 면 종료하지 않고 steers 가 다음 LLM 호출에 보인다', async () => {
    const llm = new MockLLMProvider([{ text: 'first answer' }, { text: 'second answer' }]);
    let vetoed = false;
    const services = makeServices(llm, new Map(), {
      beforeFinish: async (_ctx, reason) => {
        if (vetoed) return haltDecision(reason);
        vetoed = true;
        return proceedDecision([{ role: 'user', content: 'not done yet: check X' }]);
      },
    });

    const events = await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(llm.callLog).toHaveLength(2);
    expect(llm.callLog[1].messages).toContainEqual({ role: 'user', content: 'not done yet: check X' });
    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') expect(done.content).toBe('second answer');
  });

  it('maxIterations 소진은 beforeFinish 를 묻지 않는다 (항상 veto 해도 상한을 못 넘는다)', async () => {
    const llm = new MockLLMProvider([{ text: 'r1' }, { text: 'r2' }]);
    const gate = vi.fn(async () => proceedDecision([{ role: 'user' as const, content: 'again' }]));
    const services = makeServices(llm, new Map(), { beforeFinish: gate });

    const events = await collect(
      createReactArchitecture({ maxIterations: 2 }).loop(services as unknown as RuntimeServices, { prompt: 'go' }),
    );

    // 라운드 0·1 에서만 묻는다 — 상한에 걸린 종료는 게이트를 타지 않으므로 세 번째 호출이 없다.
    expect(gate).toHaveBeenCalledTimes(2);
    expect(llm.callLog).toHaveLength(2);
    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') expect(done.content).toBe('r2');
  });

  it('beforeModel 의 halt 는 LLM 호출 전에 끝낸다', async () => {
    const llm = new MockLLMProvider([{ text: 'never reached' }]);
    const services = makeServices(llm, new Map(), {
      beforeModel: async () => haltDecision('policy'),
    });

    const events = await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(llm.callLog).toHaveLength(0);
    expect(events.map(e => e.type)).toEqual(['done']);
  });

  it('beforeModel 의 steers 는 그 호출의 컨텍스트에 합류한다', async () => {
    const llm = new MockLLMProvider([{ text: 'ok' }]);
    const services = makeServices(llm, new Map(), {
      beforeModel: async () => proceedDecision([{ role: 'user', content: 'steered before model' }]),
    });

    await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(llm.callLog[0].messages).toContainEqual({ role: 'user', content: 'steered before model' });
  });

  it('ControlContext.turn 은 라운드마다 증가한다', async () => {
    const turns: number[] = [];
    const llm = twoRoundLLM();
    const services = makeServices(llm, echoTools(), {
      beforeModel: async (ctx) => {
        turns.push(ctx.turn);
        return proceedDecision();
      },
    });

    await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(turns).toEqual([0, 1]);
  });

  it('onInputs 가 걸러낸 입력은 모델에 보이지 않는다', async () => {
    const llm = new MockLLMProvider([{ text: 'ok' }]);
    const services = makeServices(llm, new Map()) as unknown as RuntimeServices;
    const keep: PendingRuntimeInput = { kind: 'user_prompt', originId: 'keep', input: { prompt: 'keep me' } };
    const drop: PendingRuntimeInput = { kind: 'user_prompt', originId: 'drop', input: { prompt: 'drop me' } };
    let firstClaim = true;
    const discarded: PendingRuntimeInput[] = [];
    services.inputs = {
      submit: async input => input,
      claim: async () => firstClaim ? (firstClaim = false, [keep, drop]) : [],
      admit: async () => {},
      discard: async inputs => { discarded.push(...inputs); },
    };
    services.onInputs = async (_ctx, inputs) => inputs.filter(input => input.originId === 'keep');

    await collect(createReactArchitecture().loop(services, { prompt: 'ignored' }));

    const sent = JSON.stringify(llm.callLog[0].messages);
    expect(sent).toContain('keep me');
    expect(sent).not.toContain('drop me');
    expect(discarded).toEqual([drop]);
  });

  it('onInputs 의 halt 는 LLM 호출 전에 끝낸다', async () => {
    const llm = new MockLLMProvider([{ text: 'never reached' }]);
    const services = makeServices(llm, new Map(), {
      drainSteers: () => [{ role: 'user' as const, content: 'late steer' }],
      onInputs: async () => haltDecision('policy'),
    });

    const events = await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(llm.callLog).toHaveLength(0);
    expect(events.map(e => e.type)).toEqual(['done']);
  });

  it('afterToolCall 은 확정된 도구 결과와 함께 불린다', async () => {
    const seen: { turn: number; call: ToolBatchCall; result: unknown }[] = [];
    const llm = twoRoundLLM();
    const services = makeServices(llm, echoTools(), {
      afterToolCall: async (ctx, call, result) => { seen.push({ turn: ctx.turn, call, result }); },
    });

    await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(seen).toEqual([{
      turn: 0,
      call: { callId: 't1', name: 'echo', input: { n: 1 } },
      result: { type: 'text', text: 'ok' },
    }]);
  });

  it('preToolUse 가 거부한 호출은 afterToolCall 을 타지 않는다 (도구가 돌지 않았다)', async () => {
    const llm = twoRoundLLM();
    const hook = vi.fn(async () => {});
    const services = makeServices(llm, echoTools(), {
      preToolUse: async () => denyDecision(errorResult('nope')),
      afterToolCall: hook,
    });

    await collect(createReactArchitecture().loop(services as unknown as RuntimeServices, { prompt: 'go' }));

    expect(hook).not.toHaveBeenCalled();
  });
});

describe('ReAct tool-driven termination', () => {
  const submitDefinition = (
    terminatesLoop: ToolDefinition['terminatesLoop'],
  ): ToolDefinition => ({
    name: 'submit',
    description: 'submit the final answer',
    parameters: {},
    terminatesLoop,
    execute: async () => ({ type: 'text', text: 'submitted' }),
  });

  const withDefinitions = (
    services: RuntimeServices,
    definitions: Record<string, ToolDefinition>,
  ): RuntimeServices => {
    services.tools.get = name => definitions[name];
    return services;
  };

  it('ends the run after a terminating tool succeeds', async () => {
    const llm = new MockLLMProvider([
      { text: 'wrapping up', toolCalls: [{ id: 't1', name: 'submit', arguments: {} }] },
      { text: 'should never be reached' },
    ]);
    const tools = new Map<string, (input: unknown) => Promise<unknown>>([
      ['submit', async () => ({ type: 'text' as const, text: 'submitted' })],
    ]);
    const services = withDefinitions(
      makeServices(llm, tools) as unknown as RuntimeServices,
      { submit: submitDefinition(true) },
    );

    const events = await collect(createReactArchitecture().loop(services, { prompt: 'go' }));

    expect(llm.callLog).toHaveLength(1);
    expect(events.filter(e => e.type === 'tool_result')).toHaveLength(1);
    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') expect(done.content).toBe('wrapping up');
  });

  it('keeps looping when the terminating tool returns an error', async () => {
    const llm = new MockLLMProvider([
      { text: 'trying', toolCalls: [{ id: 't1', name: 'submit', arguments: {} }] },
      { text: 'recovered' },
    ]);
    const tools = new Map<string, (input: unknown) => Promise<unknown>>([
      ['submit', async () => ({ type: 'error' as const, message: 'validation failed' })],
    ]);
    const services = withDefinitions(
      makeServices(llm, tools) as unknown as RuntimeServices,
      { submit: submitDefinition(true) },
    );

    const events = await collect(createReactArchitecture().loop(services, { prompt: 'go' }));

    expect(llm.callLog).toHaveLength(2);
    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') expect(done.content).toBe('recovered');
  });

  it('honors the predicate form against the call input', async () => {
    const llm = new MockLLMProvider([
      { text: 'draft', toolCalls: [{ id: 't1', name: 'submit', arguments: { final: false } }] },
      { text: 'final', toolCalls: [{ id: 't2', name: 'submit', arguments: { final: true } }] },
      { text: 'should never be reached' },
    ]);
    const tools = new Map<string, (input: unknown) => Promise<unknown>>([
      ['submit', async () => ({ type: 'text' as const, text: 'submitted' })],
    ]);
    const services = withDefinitions(
      makeServices(llm, tools) as unknown as RuntimeServices,
      { submit: submitDefinition(input => (input as { final?: boolean } | undefined)?.final === true) },
    );

    const events = await collect(createReactArchitecture().loop(services, { prompt: 'go' }));

    expect(llm.callLog).toHaveLength(2);
    expect(events.filter(e => e.type === 'tool_result')).toHaveLength(2);
    const done = events.find(e => e.type === 'done');
    if (done?.type === 'done') expect(done.content).toBe('final');
  });

  it('terminates the whole batch once a terminating call succeeds', async () => {
    const llm = new MockLLMProvider([
      { text: 'both', toolCalls: [
        { id: 't1', name: 'echo', arguments: {} },
        { id: 't2', name: 'submit', arguments: {} },
      ]},
      { text: 'should never be reached' },
    ]);
    const tools = new Map<string, (input: unknown) => Promise<unknown>>([
      ['echo', async () => ({ type: 'text' as const, text: 'ok' })],
      ['submit', async () => ({ type: 'text' as const, text: 'submitted' })],
    ]);
    const services = withDefinitions(
      makeServices(llm, tools) as unknown as RuntimeServices,
      { submit: submitDefinition(true) },
    );

    const events = await collect(createReactArchitecture().loop(services, { prompt: 'go' }));

    expect(llm.callLog).toHaveLength(1);
    // 배치의 두 결과 모두 방출된 뒤에 종료한다 — 중간에 잘리지 않는다.
    expect(events.filter(e => e.type === 'tool_result')).toHaveLength(2);
    expect(events.some(e => e.type === 'done')).toBe(true);
  });
});
