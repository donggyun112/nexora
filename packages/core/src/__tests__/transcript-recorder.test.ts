import { describe, it, expect } from 'vitest';
import type { TranscriptStore, TranscriptEntry, AttachmentRef } from '@dongkseo/contracts';
import { TranscriptRecorder } from '../transcript-recorder.js';

function fakeStore(): TranscriptStore & { entries: TranscriptEntry[] } {
  const entries: TranscriptEntry[] = [];
  return {
    entries,
    appendEntry: async (e) => { entries.push(e); },
    flush: async () => {},
    async *getEntries() { for (const e of entries) yield e; },
    putAttachment: async (): Promise<AttachmentRef> => ({ ref: 'img.png', mediaType: 'image/png', size: 3 }),
    getAttachment: async () => null,
    deleteConversation: async () => {},
  };
}

describe('TranscriptRecorder', () => {
  it('records user → assistant(tool_use) → user(tool_result) with linked ids and parent chain', async () => {
    const store = fakeStore();
    const rec = new TranscriptRecorder(store, 'c');
    await rec.recordUserInput({ prompt: 'read the file' });
    await rec.onEvent({ type: 'text', text: 'reading' });
    await rec.onEvent({ type: 'tool_call', id: 'c1', name: 'read', input: { path: 'a' } });
    await rec.onEvent({ type: 'tool_result', id: 'c1', name: 'read', result: { type: 'text', text: 'CONTENT' }, isError: false });
    await rec.onEvent({ type: 'done', content: 'done', toolCalls: [] });
    await rec.flush();

    const types = store.entries.map(e => e.type);
    expect(types).toEqual(['user', 'assistant', 'user', 'assistant']);

    const asst = store.entries[1] as Extract<TranscriptEntry, { type: 'assistant' }>;
    expect(asst.content).toEqual([
      { type: 'text', text: 'reading' },
      { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } },
    ]);
    const toolUser = store.entries[2] as Extract<TranscriptEntry, { type: 'user' }>;
    expect(toolUser.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'CONTENT', is_error: false },
    ]);
    // parent chain is linear
    expect(store.entries[1].parentUuid).toBe(store.entries[0].uuid);
    expect(store.entries[2].parentUuid).toBe(store.entries[1].uuid);
    expect(store.entries[3].parentUuid).toBe(store.entries[2].uuid);
  });

  it('records a no-tool turn as a single assistant entry on done', async () => {
    const store = fakeStore();
    const rec = new TranscriptRecorder(store, 'c');
    await rec.recordUserInput({ prompt: 'hi' });
    await rec.onEvent({ type: 'text', text: 'hello there' });
    await rec.onEvent({ type: 'done', content: 'hello there', toolCalls: [], model: 'm', usage: { promptTokens: 1, completionTokens: 2 } });
    await rec.flush();
    expect(store.entries.map(e => e.type)).toEqual(['user', 'assistant']);
    const asst = store.entries[1] as Extract<TranscriptEntry, { type: 'assistant' }>;
    expect(asst.content).toEqual([{ type: 'text', text: 'hello there' }]);
    expect(asst.model).toBe('m');
  });

  it('stores a tool image as an attachment_ref block', async () => {
    const store = fakeStore();
    const rec = new TranscriptRecorder(store, 'c');
    await rec.recordUserInput({ prompt: 'screenshot' });
    await rec.onEvent({ type: 'tool_call', id: 'c1', name: 'shot', input: {} });
    await rec.onEvent({ type: 'tool_result', id: 'c1', name: 'shot', result: { type: 'image', data: 'QUJD', mimeType: 'image/png' }, isError: false });
    await rec.onEvent({ type: 'done', content: '', toolCalls: [] });
    await rec.flush();
    const toolUser = store.entries.find(e => e.type === 'user' && e.parentUuid === store.entries[1].uuid) as Extract<TranscriptEntry, { type: 'user' }>;
    expect(toolUser.content).toContainEqual({ type: 'image', source: { type: 'attachment_ref', ref: 'img.png', media_type: 'image/png' } });
  });
});
