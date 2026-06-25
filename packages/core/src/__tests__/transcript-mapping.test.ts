import { describe, it, expect } from 'vitest';
import type { TranscriptEntry } from '@dongkseo/contracts';
import { llmContentToBlocks, toLLMMessages } from '../transcript-mapping.js';

const noImages = async () => null;

describe('llmContentToBlocks', () => {
  it('maps tool_call → tool_use and tool_result id → tool_use_id', () => {
    expect(llmContentToBlocks([
      { type: 'text', text: 'hi' },
      { type: 'tool_call', id: 'c1', name: 'read', arguments: { path: 'a' } },
    ])).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } },
    ]);
    expect(llmContentToBlocks([{ type: 'tool_result', id: 'c1', content: 'ok', isError: true }]))
      .toEqual([{ type: 'tool_result', tool_use_id: 'c1', content: 'ok', is_error: true }]);
  });
  it('wraps a plain string as a single text block', () => {
    expect(llmContentToBlocks('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });
});

describe('toLLMMessages', () => {
  const base = { conversationId: 'x', schemaVersion: 'v2' as const, timestamp: '2026-06-25T00:00:00Z' };
  it('round-trips assistant tool_use and user tool_result into rich LLM messages', async () => {
    const entries: TranscriptEntry[] = [
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, content: [{ type: 'text', text: 'go' }] },
      { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }] },
      { ...base, type: 'user', uuid: 'r1', parentUuid: 'a1', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
    ];
    expect(await toLLMMessages(entries, noImages)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: 'ok', isError: false }] },
    ]);
  });
  it('drops entries superseded by a summary and injects the summary text', async () => {
    const entries: TranscriptEntry[] = [
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, content: [{ type: 'text', text: 'old' }] },
      { ...base, type: 'summary', uuid: 's1', parentUuid: 'u1', summary: 'SUMMARY', supersedesUpToUuid: 'u1' },
      { ...base, type: 'assistant', uuid: 'a2', parentUuid: 's1', content: [{ type: 'text', text: 'new' }] },
    ];
    expect(await toLLMMessages(entries, noImages)).toEqual([
      { role: 'user', content: 'SUMMARY' },
      { role: 'assistant', content: [{ type: 'text', text: 'new' }] },
    ]);
  });
  it('resolves attachment_ref images to base64 blocks', async () => {
    const entries: TranscriptEntry[] = [
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, content: [
        { type: 'image', source: { type: 'attachment_ref', ref: 'abc.png', media_type: 'image/png' } },
      ] },
    ];
    const resolve = async (ref: string) => (ref === 'abc.png' ? 'BYTES' : null);
    expect(await toLLMMessages(entries, resolve)).toEqual([
      { role: 'user', content: [{ type: 'image', data: 'BYTES', mimeType: 'image/png' }] },
    ]);
  });
  it('completes a dangling tool_use with a stub tool_result on replay', async () => {
    // sanitizeToolPairsInPlace injects a stub tool_result for an orphaned tool_call
    // (it does NOT drop it) — keeps the pair valid for the provider.
    const entries: TranscriptEntry[] = [
      { ...base, type: 'assistant', uuid: 'a1', parentUuid: null, content: [{ type: 'tool_use', id: 'c1', name: 'x', input: {} }] },
    ];
    expect(await toLLMMessages(entries, noImages)).toEqual([
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'x', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: '[result lost during context compaction]', isError: false }] },
    ]);
  });
});
