import { describe, it, expect } from 'vitest';
import { toPiContext, toPiOptions, fromPiAssistantMessage } from '../llm/pi-ai/mapping.js';
import type { AssistantMessage } from '@earendil-works/pi-ai';

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

  it('forwards tool definitions verbatim', () => {
    const tools = [{ name: 'x', description: 'd', parameters: { type: 'object' } }];
    expect(toPiOptions({ tools }).tools).toEqual(tools);
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

  it('preserves "aborted" stopReason verbatim', () => {
    const r = fromPiAssistantMessage(makeMsg({
      stopReason: 'aborted',
    }));
    expect(r.stopReason).toBe('aborted');
  });
});
