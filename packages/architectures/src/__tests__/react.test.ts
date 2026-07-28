import { describe, it, expect, vi } from 'vitest';
import { createReactArchitecture } from '../react.js';
import { MockLLMProvider, makeServices } from './mock-llm.js';
import type { AgentEvent, RuntimeServices, LLMMessage, ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { suspendResult } from '@dongkseo/contracts';

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('ReactArchitecture', () => {
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
