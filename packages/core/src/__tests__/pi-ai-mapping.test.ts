import { describe, it, expect } from 'vitest';
import { toPiContext, toPiOptions, fromPiAssistantMessage, fromPiChunk } from '../llm/pi-ai/mapping.js';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';

describe('toPiContext', () => {
  it('extracts system message from messages array into systemPrompt', () => {
    const result = toPiContext([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(result.systemPrompt).toBe('You are helpful.');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      role: 'user',
      content: 'hi',
    });
  });

  it('uses options.systemPrompt when no system message in messages', () => {
    const result = toPiContext(
      [{ role: 'user', content: 'hi' }],
      { systemPrompt: 'from options' },
    );
    expect(result.systemPrompt).toBe('from options');
  });

  it('options.systemPrompt is overridden by inline system message', () => {
    const result = toPiContext(
      [
        { role: 'system', content: 'inline' },
        { role: 'user', content: 'hi' },
      ],
      { systemPrompt: 'from options' },
    );
    expect(result.systemPrompt).toBe('inline');
  });

  it('preserves string user content as-is (pi-ai accepts string)', () => {
    const result = toPiContext([{ role: 'user', content: 'hello' }]);
    expect(result.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('converts assistant string content into TextContent block array', () => {
    const result = toPiContext([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hi back' },
    ]);
    expect(result.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi back' }],
    });
  });

  it('converts assistant tool_call blocks to pi-ai toolCall blocks', () => {
    const result = toPiContext([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool_call', id: 'call_1', name: 'search', arguments: { q: 'x' } },
        ],
      },
    ]);
    expect(result.messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'toolCall', id: 'call_1', name: 'search', arguments: { q: 'x' } },
      ],
    });
  });

  it('converts tool_result message into pi-ai toolResult message', () => {
    const result = toPiContext([
      {
        role: 'tool_result',
        content: [
          { type: 'tool_result', id: 'call_1', content: 'OK', isError: false },
        ],
      },
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'OK' }],
      isError: false,
    });
  });

  it('converts user image content block (mixed text+image array)', () => {
    const result = toPiContext([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image', data: 'BASE64DATA', mimeType: 'image/png' },
        ],
      },
    ]);
    expect(result.messages[0].content).toEqual([
      { type: 'text', text: 'see this' },
      { type: 'image', data: 'BASE64DATA', mimeType: 'image/png' },
    ]);
  });

  it('splits a single tool_result message with multiple results into one toolResult per id', () => {
    const result = toPiContext([
      {
        role: 'tool_result',
        content: [
          { type: 'tool_result', id: 'a', content: 'A out', isError: false },
          { type: 'tool_result', id: 'b', content: 'B err', isError: true },
        ],
      },
    ]);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ role: 'toolResult', toolCallId: 'a', isError: false });
    expect(result.messages[1]).toMatchObject({ role: 'toolResult', toolCallId: 'b', isError: true });
  });

  it('assistant message has the required pi-ai sentinel fields for replay', () => {
    const result = toPiContext([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'reply' },
    ]);
    const asst = result.messages[1] as { stopReason?: string; usage?: unknown; model?: string };
    expect(asst.stopReason).toBe('stop');
    expect(asst.usage).toBeDefined();
    expect(asst.model).toBe('replay');
  });

  it('reconstructs toolName on tool_result from preceding assistant tool_call', () => {
    const result = toPiContext([
      { role: 'user', content: 'search please' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'call_42', name: 'web_search', arguments: { q: 'x' } },
        ],
      },
      {
        role: 'tool_result',
        content: [
          { type: 'tool_result', id: 'call_42', content: 'hits', isError: false },
        ],
      },
    ]);
    const toolResult = result.messages.find(m => m.role === 'toolResult') as { toolName: string };
    expect(toolResult.toolName).toBe('web_search');
  });

  it('falls back to empty toolName when no matching tool_call precedes', () => {
    const result = toPiContext([
      {
        role: 'tool_result',
        content: [
          { type: 'tool_result', id: 'orphan', content: 'x', isError: false },
        ],
      },
    ]);
    const toolResult = result.messages[0] as { toolName: string };
    expect(toolResult.toolName).toBe('');
  });

  it('uses caller-provided api/provider for assistant replay shape', () => {
    const result = toPiContext(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'reply' },
      ],
      undefined,
      { api: 'anthropic-messages', provider: 'anthropic' },
    );
    const asst = result.messages[1] as { api: string; provider: string };
    expect(asst.api).toBe('anthropic-messages');
    expect(asst.provider).toBe('anthropic');
  });
});

describe('toPiOptions', () => {
  it('maps thinkingLevel to reasoning, dropping "off"', () => {
    expect(toPiOptions({ thinkingLevel: 'high' }).reasoning).toBe('high');
    expect(toPiOptions({ thinkingLevel: 'off' }).reasoning).toBeUndefined();
    expect(toPiOptions(undefined).reasoning).toBeUndefined();
  });

  it('forwards signal, maxTokens, temperature', () => {
    const ac = new AbortController();
    const r = toPiOptions({ signal: ac.signal, maxTokens: 100, temperature: 0.4 });
    expect(r.signal).toBe(ac.signal);
    expect(r.maxTokens).toBe(100);
    expect(r.temperature).toBe(0.4);
  });

  it('returns empty object for undefined input', () => {
    expect(toPiOptions(undefined)).toEqual({});
  });
});

describe('fromPiAssistantMessage', () => {
  // Helper that constructs the bare minimum AssistantMessage shape pi-ai requires.
  // The Usage type may have additional cost fields — we use `as never` casts to
  // sidestep strict typing for test fixtures.
  const makeMsg = (over: {
    content?: AssistantMessage['content'];
    stopReason?: AssistantMessage['stopReason'];
    usage?: Partial<AssistantMessage['usage']>;
  }): AssistantMessage => ({
    role: 'assistant',
    content: over.content ?? [],
    stopReason: over.stopReason ?? 'stop',
    usage: {
      input: 10, output: 5,
      cost: { input: 0, output: 0, total: 0 },
      ...over.usage,
    },
    api: 'openai-completions',
    provider: 'openai',
    model: 'test-model',
    timestamp: 0,
  } as never);

  it('extracts text content', () => {
    const r = fromPiAssistantMessage(makeMsg({
      content: [{ type: 'text', text: 'hello' }],
    }));
    expect(r.content).toBe('hello');
    expect(r.stopReason).toBe('end_turn');
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: 0 });
  });

  it('extracts tool calls and maps stopReason toolUse to tool_use', () => {
    const r = fromPiAssistantMessage(makeMsg({
      content: [
        { type: 'text', text: 'using tool' },
        { type: 'toolCall', id: 'c1', name: 'search', arguments: { q: 'x' } },
      ],
      stopReason: 'toolUse',
    }));
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'search', arguments: { q: 'x' } }]);
    expect(r.stopReason).toBe('tool_use');
  });

  it('reports cacheRead usage when available', () => {
    const r = fromPiAssistantMessage(makeMsg({
      usage: {
        input: 10, output: 5,
        cost: { input: 0, output: 0, total: 0, cacheRead: 100 },
      } as never,
    }));
    expect(r.usage?.cachedTokens).toBe(100);
  });

  it('omits toolCalls when none present', () => {
    const r = fromPiAssistantMessage(makeMsg({
      content: [{ type: 'text', text: 'just text' }],
    }));
    expect(r.toolCalls).toBeUndefined();
  });

  it('throws AbortError when stopReason is aborted (pi-ai error path)', () => {
    expect(() => fromPiAssistantMessage(makeMsg({
      stopReason: 'aborted',
    }))).toThrow();
    let caught: Error | undefined;
    try { fromPiAssistantMessage(makeMsg({ stopReason: 'aborted' })); } catch (e) { caught = e as Error; }
    expect(caught?.name).toBe('AbortError');
  });
});

describe('fromPiAssistantMessage error handling', () => {
  it('throws Error when stopReason is error', () => {
    expect(() => fromPiAssistantMessage({
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'rate limited',
      usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
      api: 'openai-completions', provider: 'openai', model: 'm', timestamp: 0,
    } as never)).toThrow('rate limited');
  });

  it('throws AbortError when stopReason is aborted', () => {
    let caught: Error | undefined;
    try {
      fromPiAssistantMessage({
        role: 'assistant',
        content: [],
        stopReason: 'aborted',
        errorMessage: 'cancelled',
        usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
        api: 'openai-completions', provider: 'openai', model: 'm', timestamp: 0,
      } as never);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.name).toBe('AbortError');
    expect(caught?.message).toBe('cancelled');
  });

  it('falls back to generic message when errorMessage is missing', () => {
    expect(() => fromPiAssistantMessage({
      role: 'assistant',
      content: [],
      stopReason: 'error',
      usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
      api: 'openai-completions', provider: 'openai', model: 'm', timestamp: 0,
    } as never)).toThrow('pi-ai error');
  });
});

describe('fromPiChunk', () => {
  const newState = () => ({ toolNames: new Map<string, string>() });
  const stubPartial = (over: Partial<AssistantMessage> = {}): AssistantMessage => ({
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'openai',
    model: 'm',
    stopReason: 'stop',
    usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
    timestamp: 0,
    ...over,
  } as never);

  it('maps text_delta to text_delta', () => {
    const r = fromPiChunk(
      { type: 'text_delta', delta: 'hi', contentIndex: 0, partial: stubPartial() } as AssistantMessageEvent,
      newState(),
    );
    expect(r).toEqual({ type: 'text_delta', delta: 'hi' });
  });

  it('maps thinking_delta to thinking_delta', () => {
    const r = fromPiChunk(
      { type: 'thinking_delta', delta: '...', contentIndex: 0, partial: stubPartial() } as AssistantMessageEvent,
      newState(),
    );
    expect(r).toEqual({ type: 'thinking_delta', delta: '...' });
  });

  it('maps toolcall_start by reading id+name from partial.content[contentIndex] and remembers id', () => {
    const state = newState();
    const partial = stubPartial({
      content: [{ type: 'toolCall', id: 't1', name: 'search', arguments: {} }],
    });
    const r = fromPiChunk(
      { type: 'toolcall_start', contentIndex: 0, partial } as AssistantMessageEvent,
      state,
    );
    expect(r).toEqual({ type: 'tool_call_start', id: 't1', name: 'search' });
    expect(state.toolNames.get('0')).toBe('t1');
  });

  it('maps toolcall_delta to tool_call_delta resolving id from state by contentIndex', () => {
    const state = newState();
    state.toolNames.set('0', 't1');
    const partial = stubPartial({
      content: [{ type: 'toolCall', id: 't1', name: 'search', arguments: {} }],
    });
    const r = fromPiChunk(
      { type: 'toolcall_delta', delta: '{"q":', contentIndex: 0, partial } as AssistantMessageEvent,
      state,
    );
    expect(r).toEqual({ type: 'tool_call_delta', id: 't1', delta: '{"q":' });
  });

  it('maps done event to done chunk with text-joined content and remapped stopReason', () => {
    const r = fromPiChunk(
      {
        type: 'done',
        reason: 'stop',
        message: stubPartial({
          content: [{ type: 'text', text: 'final' }],
          stopReason: 'stop',
        }),
      } as AssistantMessageEvent,
      newState(),
    );
    expect(r).toEqual({ type: 'done', content: 'final', stopReason: 'end_turn' });
  });

  it('returns undefined for events that have no Nexora equivalent', () => {
    const p = stubPartial();
    expect(fromPiChunk({ type: 'start', partial: p } as AssistantMessageEvent, newState())).toBeUndefined();
    expect(fromPiChunk({ type: 'text_start', contentIndex: 0, partial: p } as AssistantMessageEvent, newState())).toBeUndefined();
    expect(fromPiChunk({ type: 'text_end', contentIndex: 0, content: 'x', partial: p } as AssistantMessageEvent, newState())).toBeUndefined();
    expect(fromPiChunk({ type: 'thinking_start', contentIndex: 0, partial: p } as AssistantMessageEvent, newState())).toBeUndefined();
    expect(fromPiChunk({ type: 'thinking_end', contentIndex: 0, content: 'x', partial: p } as AssistantMessageEvent, newState())).toBeUndefined();
    expect(fromPiChunk({ type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 't1', name: 's', arguments: {} }, partial: p } as AssistantMessageEvent, newState())).toBeUndefined();
  });
});

describe('fromPiChunk error handling', () => {
  const state = () => ({ toolNames: new Map<string, string>() });

  it('throws Error on pi-ai error event with reason=error', () => {
    expect(() => fromPiChunk({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant', content: [], stopReason: 'error',
        errorMessage: 'upstream 500',
        usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
        api: 'openai-completions', provider: 'openai', model: 'm', timestamp: 0,
      },
    } as never, state())).toThrow('upstream 500');
  });

  it('throws AbortError on pi-ai error event with reason=aborted', () => {
    let caught: Error | undefined;
    try {
      fromPiChunk({
        type: 'error',
        reason: 'aborted',
        error: {
          role: 'assistant', content: [], stopReason: 'aborted',
          errorMessage: 'user cancelled',
          usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
          api: 'openai-completions', provider: 'openai', model: 'm', timestamp: 0,
        },
      } as never, state());
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.name).toBe('AbortError');
    expect(caught?.message).toBe('user cancelled');
  });
});
