import { describe, it, expect } from 'vitest';
import { TranscriptRecorder } from '../transcript-recorder.js';
import type { TranscriptEntry, TranscriptStore } from '@dongkseo/contracts';

function fakeStore(): { store: TranscriptStore; entries: TranscriptEntry[] } {
  const entries: TranscriptEntry[] = [];
  const store = {
    appendEntry: async (e: TranscriptEntry) => { entries.push(e); },
    putAttachment: async () => ({ ref: 'r', mediaType: 'image/png', size: 0 }),
    read: async function* () {},
    flush: async () => {},
  } as unknown as TranscriptStore;
  return { store, entries };
}

describe('TranscriptRecorder.recordFallback', () => {
  it('appends a synthetic-fallback assistant entry with metadata', async () => {
    const { store, entries } = fakeStore();
    const rec = new TranscriptRecorder(store, 'conv-1');
    await rec.recordFallback({ from: 'openai-codex/gpt-5.5', to: 'anthropic/claude-sonnet-4-6', errorClass: 'rate-limit', status: 429 });
    expect(entries).toHaveLength(1);
    const e = entries[0] as Extract<TranscriptEntry, { type: 'assistant' }>;
    expect(e.type).toBe('assistant');
    expect(e.conversationId).toBe('conv-1');
    expect(e.model).toBe('<synthetic-fallback>');
    expect(e.metadata).toMatchObject({
      event: 'llm_fallback', from: 'openai-codex/gpt-5.5',
      to: 'anthropic/claude-sonnet-4-6', errorClass: 'rate-limit', status: 429,
    });
    expect(JSON.stringify(e.content)).toContain('gpt-5.5');
  });

  it('does not advance lastUuid (real lineage preserved)', async () => {
    const { store, entries } = fakeStore();
    const rec = new TranscriptRecorder(store, 'conv-1');
    await rec.recordUserInput({ prompt: 'hi' } as never);   // sets lastUuid = user uuid
    const userUuid = entries[0].uuid;
    await rec.recordFallback({ from: 'a', to: 'b', errorClass: 'rate-limit' });
    await rec.recordUserInput({ prompt: 'next' } as never);
    const fallbackEntry = entries[1];
    const nextUser = entries[2];
    expect(fallbackEntry.parentUuid).toBe(userUuid);
    expect(nextUser.parentUuid).toBe(userUuid);
  });
});
