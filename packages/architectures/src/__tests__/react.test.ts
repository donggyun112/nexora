import { describe, it, expect } from 'vitest';
import { createReactArchitecture } from '../react.js';
import { MockLLMProvider, makeServices } from './mock-llm.js';
import type { AgentEvent, RuntimeServices, LLMMessage } from '@nexora/contracts';
import { suspendResult } from '@nexora/contracts';

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

  it('first suspend in a parallel batch terminates the turn', async () => {
    const llm = new MockLLMProvider([
      { text: '', toolCalls: [
        { id: 'call-1', name: 'ask', arguments: {} },
        { id: 'call-2', name: 'echo', arguments: { msg: 'hi' } },
      ]},
    ]);
    const tools = new Map<string, (input: unknown) => Promise<unknown>>([
      ['ask', async () => suspendResult('p1')],
      ['echo', async () => ({ type: 'text' as const, text: 'echoed' })],
    ]);
    const services = makeServices(llm, tools);
    const arch = createReactArchitecture();
    const events = await collect(arch.loop(services as unknown as RuntimeServices, { prompt: 'q' }));
    expect(events.some(e => e.type === 'suspended' && (e as { type: 'suspended'; pendingId: string }).pendingId === 'p1')).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(false);
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
});
