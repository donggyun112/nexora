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

describe('PiAiProvider error propagation', () => {
  beforeEach(() => {
    vi.mocked(piAi.complete).mockReset();
    vi.mocked(piAi.stream).mockReset();
  });

  it('complete() throws when pi-ai returns stopReason error', async () => {
    vi.mocked(piAi.complete).mockResolvedValueOnce({
      role: 'assistant', content: [], stopReason: 'error',
      errorMessage: 'rate limited',
      usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
      api: 'openai-completions', provider: 'openai', model: 'm', timestamp: 0,
    } as never);

    const p = new PiAiProvider({ provider: 'openai', model: 'gpt-4o-mini' });
    await expect(p.complete([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('rate limited');
  });

  it('stream() propagates pi-ai error event as thrown Error', async () => {
    async function* fakeEvents() {
      yield { type: 'text_delta', delta: 'partial', contentIndex: 0, partial: baseAsstMsg({ content: [] }) } as piAi.AssistantMessageEvent;
      yield {
        type: 'error', reason: 'error',
        error: {
          role: 'assistant', content: [], stopReason: 'error',
          errorMessage: 'upstream went down',
          usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
          api: 'openai-completions', provider: 'openai', model: 'm', timestamp: 0,
        },
      } as never;
    }
    vi.mocked(piAi.stream).mockReturnValueOnce(fakeEvents() as never);

    const p = new PiAiProvider({ provider: 'openai', model: 'gpt-4o-mini' });
    const collected: unknown[] = [];
    let thrown: Error | undefined;
    try {
      for await (const c of p.stream([{ role: 'user', content: 'hi' }])) collected.push(c);
    } catch (e) { thrown = e as Error; }

    expect(thrown?.message).toBe('upstream went down');
    expect(collected).toContainEqual({ type: 'text_delta', delta: 'partial' });
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

describe('PiAiProvider per-call model override', () => {
  beforeEach(() => {
    vi.mocked(piAi.complete).mockReset();
    vi.mocked(piAi.getModel).mockReset();
  });

  it('complete() uses options.model when provided, defaults to constructor model otherwise', async () => {
    const capturedModels: unknown[] = [];
    vi.mocked(piAi.complete).mockImplementation(async (model: unknown) => {
      capturedModels.push(model);
      return {
        role: 'assistant', content: [{ type: 'text', text: 'ok' }],
        stopReason: 'stop',
        usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
        api: 'openai-completions', provider: 'openai', model: 'mock', timestamp: 0,
      } as never;
    });

    const modelA = { id: 'mockA', api: 'openai-completions', provider: 'openai' } as never;
    const modelB = { id: 'mockB', api: 'openai-completions', provider: 'openai' } as never;
    vi.mocked(piAi.getModel).mockImplementation((_p: unknown, name: unknown) => {
      if (name === 'gpt-4o') return modelA;
      if (name === 'gpt-4o-mini') return modelB;
      throw new Error(`unknown ${name}`);
    });

    const p = new PiAiProvider({ provider: 'openai', model: 'gpt-4o' });
    await p.complete([{ role: 'user', content: 'a' }]);
    await p.complete([{ role: 'user', content: 'b' }], { model: 'gpt-4o-mini' });
    await p.complete([{ role: 'user', content: 'c' }]);

    expect(capturedModels[0]).toBe(modelA);
    expect(capturedModels[1]).toBe(modelB);
    expect(capturedModels[2]).toBe(modelA);
  });

  it('caches model resolutions across calls', async () => {
    vi.mocked(piAi.complete).mockResolvedValue({
      role: 'assistant', content: [{ type: 'text', text: 'ok' }],
      stopReason: 'stop',
      usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
      api: 'openai-completions', provider: 'openai', model: 'mock', timestamp: 0,
    } as never);
    vi.mocked(piAi.getModel).mockImplementation((_p: unknown, _n: unknown) =>
      ({ id: 'mock', api: 'openai-completions', provider: 'openai' } as never));

    const p = new PiAiProvider({ provider: 'openai', model: 'gpt-4o' });
    // constructor consumed 1 getModel call. Now do 3 overrides with the same name.
    await p.complete([{ role: 'user', content: 'a' }], { model: 'gpt-4o-mini' });
    await p.complete([{ role: 'user', content: 'b' }], { model: 'gpt-4o-mini' });
    await p.complete([{ role: 'user', content: 'c' }], { model: 'gpt-4o-mini' });

    // 1 for constructor + 1 for the first override (cached after) = 2 total
    expect(vi.mocked(piAi.getModel)).toHaveBeenCalledTimes(2);
  });

  it('response.model reflects the override when used', async () => {
    vi.mocked(piAi.getModel).mockImplementation((_p: unknown, name: unknown) =>
      ({ id: name, api: 'openai-completions', provider: 'openai' } as never));
    vi.mocked(piAi.complete).mockResolvedValue({
      role: 'assistant', content: [{ type: 'text', text: 'hi' }],
      stopReason: 'stop',
      usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
      api: 'openai-completions', provider: 'openai', model: 'mock', timestamp: 0,
    } as never);

    const p = new PiAiProvider({ provider: 'openai', model: 'gpt-4o' });
    const r1 = await p.complete([{ role: 'user', content: 'q' }]);
    const r2 = await p.complete([{ role: 'user', content: 'q' }], { model: 'gpt-4o-mini' });
    expect(r1.model).toBe('gpt-4o');
    expect(r2.model).toBe('gpt-4o-mini');
  });
});
