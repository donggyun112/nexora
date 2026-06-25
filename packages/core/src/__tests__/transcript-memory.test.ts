import { describe, it, expect } from 'vitest';
import type { TranscriptStore, TranscriptEntry, AttachmentRef } from '@dongkseo/contracts';
import { TranscriptMemoryProvider } from '../transcript-memory.js';

function fakeStore(seed: TranscriptEntry[] = []): TranscriptStore & { entries: TranscriptEntry[] } {
  const entries = [...seed];
  return {
    entries,
    appendEntry: async (e: TranscriptEntry) => { entries.push(e); },
    flush: async () => {},
    async *getEntries(_id, opts) { const s = opts?.limit ? Math.max(0, entries.length - opts.limit) : 0; for (let i = s; i < entries.length; i++) yield entries[i]; },
    putAttachment: async (): Promise<AttachmentRef> => ({ ref: 'r', mediaType: 'image/png', size: 0 }),
    getAttachment: async () => null,
    deleteConversation: async () => { entries.length = 0; },
  };
}
const base = { conversationId: 'c', schemaVersion: 'v2' as const, timestamp: '2026-06-25T00:00:00Z' };

describe('TranscriptMemoryProvider', () => {
  it('getHistory replays stored entries as rich LLM messages', async () => {
    const store = fakeStore([
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, content: [{ type: 'text', text: 'go' }] },
      { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }] },
      { ...base, type: 'user', uuid: 'r1', parentUuid: 'a1', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
    ]);
    const mem = new TranscriptMemoryProvider(store, 'c');
    expect(await mem.getHistory()).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool_result', content: [{ type: 'tool_result', id: 'c1', content: 'ok', isError: false }] },
    ]);
  });
  it('append is a no-op (recorder is the writer)', async () => {
    const store = fakeStore();
    const mem = new TranscriptMemoryProvider(store, 'c');
    await mem.append({ role: 'user', content: 'x' });
    expect(store.entries).toEqual([]);
  });
  it('clear delegates to deleteConversation', async () => {
    const store = fakeStore([{ ...base, type: 'user', uuid: 'u1', parentUuid: null, content: [] }]);
    const mem = new TranscriptMemoryProvider(store, 'c');
    await mem.clear();
    expect(store.entries).toEqual([]);
  });
});
