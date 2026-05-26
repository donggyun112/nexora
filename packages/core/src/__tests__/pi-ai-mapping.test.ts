import { describe, it, expect } from 'vitest';
import { toPiContext } from '../llm/pi-ai/mapping.js';

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
