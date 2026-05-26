import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PiAiProvider } from '../llm/pi-ai/provider.js';

// Mock pi-ai at module level — we don't want real network calls.
vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>();
  return {
    ...actual,
    stream: vi.fn(),
    complete: vi.fn(),
    getModel: vi.fn(() => ({
      id: 'mock',
      name: 'mock',
      api: 'openai-completions' as const,
      provider: 'openai' as const,
      reasoning: false,
      input: ['text'] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 1000,
    })),
  };
});

import * as piAi from '@earendil-works/pi-ai';

const baseAsstMsg = (over: Partial<{
  content: piAi.AssistantMessage['content'];
  stopReason: piAi.AssistantMessage['stopReason'];
}>): piAi.AssistantMessage => ({
  role: 'assistant',
  content: over.content ?? [],
  stopReason: over.stopReason ?? 'stop',
  api: 'openai-completions',
  provider: 'openai',
  model: 'mock',
  usage: { input: 20, output: 5, cost: { input: 0, output: 0, total: 0 } },
  timestamp: 0,
} as never);

describe('PiAiProvider.complete', () => {
  beforeEach(() => { vi.mocked(piAi.complete).mockReset(); });

  it('returns content and tool calls from pi-ai assistant message', async () => {
    vi.mocked(piAi.complete).mockResolvedValueOnce(baseAsstMsg({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'toolCall', id: 'c1', name: 'search', arguments: { q: 'x' } },
      ],
      stopReason: 'toolUse',
    }));

    const p = new PiAiProvider({ provider: 'openai', model: 'gpt-4o-mini' });
    const r = await p.complete([{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('hello');
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'search', arguments: { q: 'x' } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage?.promptTokens).toBe(20);
    expect(r.model).toBe('gpt-4o-mini');
  });

  it('propagates AbortSignal to pi-ai options', async () => {
    const ac = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(piAi.complete).mockImplementationOnce((_m, _c, opts) => {
      capturedSignal = (opts as { signal?: AbortSignal })?.signal;
      return Promise.resolve(baseAsstMsg({ content: [{ type: 'text', text: '' }] }));
    });

    const p = new PiAiProvider({ provider: 'openai', model: 'gpt-4o-mini' });
    await p.complete([{ role: 'user', content: 'hi' }], { signal: ac.signal });
    expect(capturedSignal).toBe(ac.signal);
  });

  it('forwards apiKey/sessionId/cacheRetention when constructor sets them', async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    vi.mocked(piAi.complete).mockImplementationOnce((_m, _c, opts) => {
      capturedOpts = opts as Record<string, unknown>;
      return Promise.resolve(baseAsstMsg({ content: [] }));
    });
    const p = new PiAiProvider({
      provider: 'anthropic', model: 'claude-x',
      apiKey: 'sk-test', sessionId: 'sess1', cacheRetention: 'long',
    });
    await p.complete([{ role: 'user', content: 'hi' }]);
    expect(capturedOpts?.apiKey).toBe('sk-test');
    expect(capturedOpts?.sessionId).toBe('sess1');
    expect(capturedOpts?.cacheRetention).toBe('long');
  });
});

describe('PiAiProvider.stream', () => {
  beforeEach(() => { vi.mocked(piAi.stream).mockReset(); });

  it('yields text_delta and done chunks', async () => {
    async function* fakeEvents() {
      const partial = baseAsstMsg({ content: [] });
      yield { type: 'start', partial } as piAi.AssistantMessageEvent;
      yield { type: 'text_start', contentIndex: 0, partial } as piAi.AssistantMessageEvent;
      yield { type: 'text_delta', delta: 'hi', contentIndex: 0, partial } as piAi.AssistantMessageEvent;
      yield { type: 'text_end', contentIndex: 0, content: 'hi', partial } as piAi.AssistantMessageEvent;
      yield {
        type: 'done',
        reason: 'stop',
        message: baseAsstMsg({ content: [{ type: 'text', text: 'hi' }] }),
      } as piAi.AssistantMessageEvent;
    }
    vi.mocked(piAi.stream).mockReturnValueOnce(fakeEvents() as never);

    const p = new PiAiProvider({ provider: 'openai', model: 'gpt-4o-mini' });
    const chunks = [];
    for await (const c of p.stream([{ role: 'user', content: 'hi' }])) chunks.push(c);

    expect(chunks).toContainEqual({ type: 'text_delta', delta: 'hi' });
    expect(chunks.at(-1)).toEqual({ type: 'done', content: 'hi', stopReason: 'end_turn' });
  });

  it('streams tool calls — emits tool_call_start then tool_call_delta with correct id', async () => {
    const partial = baseAsstMsg({
      content: [{ type: 'toolCall', id: 'call_xyz', name: 'search', arguments: {} }],
    });
    async function* fakeEvents() {
      yield { type: 'toolcall_start', contentIndex: 0, partial } as piAi.AssistantMessageEvent;
      yield { type: 'toolcall_delta', delta: '{"q":"x"}', contentIndex: 0, partial } as piAi.AssistantMessageEvent;
      yield {
        type: 'done',
        reason: 'toolUse',
        message: baseAsstMsg({
          content: [{ type: 'toolCall', id: 'call_xyz', name: 'search', arguments: { q: 'x' } }],
          stopReason: 'toolUse',
        }),
      } as piAi.AssistantMessageEvent;
    }
    vi.mocked(piAi.stream).mockReturnValueOnce(fakeEvents() as never);

    const p = new PiAiProvider({ provider: 'openai', model: 'gpt-4o-mini' });
    const chunks = [];
    for await (const c of p.stream([{ role: 'user', content: 'hi' }])) chunks.push(c);

    expect(chunks).toContainEqual({ type: 'tool_call_start', id: 'call_xyz', name: 'search' });
    expect(chunks).toContainEqual({ type: 'tool_call_delta', id: 'call_xyz', delta: '{"q":"x"}' });
  });
});
