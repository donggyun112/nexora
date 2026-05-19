import { describe, it, expect } from 'vitest';
import { createReactArchitecture } from '../react.js';
import { MockLLMProvider, makeServices } from './mock-llm.js';
import type { AgentEvent, RuntimeServices } from '@nexora/contracts';

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

  it('runs multiple parallel tool calls in one round', async () => {
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
