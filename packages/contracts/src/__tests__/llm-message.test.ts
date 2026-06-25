import { describe, it, expect } from 'vitest';
import type { LLMMessage } from '../agent.js';
import { imageResultForLLM, sanitizeToolPairsInPlace } from '../llm-message.js';

describe('imageResultForLLM', () => {
  it('extracts an image content block from an image tool result', () => {
    expect(imageResultForLLM({ type: 'image', data: 'AAA', mimeType: 'image/png' }))
      .toEqual({ type: 'image', data: 'AAA', mimeType: 'image/png' });
  });
  it('returns null for non-image results', () => {
    expect(imageResultForLLM({ type: 'text', text: 'hi' })).toBeNull();
    expect(imageResultForLLM('plain')).toBeNull();
  });
});

describe('sanitizeToolPairsInPlace', () => {
  it('creates a stub tool_result for an assistant tool_call with no matching tool_result', () => {
    const history: LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'x', arguments: {} }] },
    ];
    sanitizeToolPairsInPlace(history);
    expect(history).toEqual([
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'x', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: '[result lost during context compaction]', isError: false }] },
    ]);
  });
  it('keeps a complete tool_call/tool_result pair', () => {
    const history: LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'x', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: 'ok' }] },
    ];
    const before = JSON.parse(JSON.stringify(history));
    sanitizeToolPairsInPlace(history);
    expect(history).toEqual(before);
  });

  it('pulls a tool_result adjacent when a user message is interleaved before it', () => {
    const history: LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'x', arguments: {} }] },
      { role: 'user', content: 'stop' },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: 'ok' }] },
    ];
    sanitizeToolPairsInPlace(history);
    expect(history).toEqual([
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'x', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: 'ok' }] },
      { role: 'user', content: 'stop' },
    ]);
  });

  it('merges scattered results for one assistant into a single adjacent message in call order', () => {
    const history: LLMMessage[] = [
      { role: 'assistant', content: [
        { type: 'tool_call', id: 'c1', name: 'x', arguments: {} },
        { type: 'tool_call', id: 'c2', name: 'y', arguments: {} },
      ] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: 'r1' }] },
      { role: 'user', content: 'resumed' },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c2', content: 'r2' }] },
    ];
    sanitizeToolPairsInPlace(history);
    expect(history).toEqual([
      { role: 'assistant', content: [
        { type: 'tool_call', id: 'c1', name: 'x', arguments: {} },
        { type: 'tool_call', id: 'c2', name: 'y', arguments: {} },
      ] },
      { role: 'tool_result', content: [
        { type: 'tool_result', id: 'c1', content: 'r1' },
        { type: 'tool_result', id: 'c2', content: 'r2' },
      ] },
      { role: 'user', content: 'resumed' },
    ]);
  });

  it('gives each of two consecutive assistant tool_call messages its own adjacent result', () => {
    const history: LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'a1', name: 'x', arguments: {} }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'b1', name: 'y', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'a1', content: 'ra' }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'b1', content: 'rb' }] },
    ];
    sanitizeToolPairsInPlace(history);
    expect(history).toEqual([
      { role: 'assistant', content: [{ type: 'tool_call', id: 'a1', name: 'x', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'a1', content: 'ra' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'b1', name: 'y', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'b1', content: 'rb' }] },
    ]);
  });
});
