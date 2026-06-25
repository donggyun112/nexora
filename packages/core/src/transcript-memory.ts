import { randomUUID } from 'node:crypto';
import type { TranscriptStore, LLMMessage, MemoryProvider, ChatMessage, TranscriptEntry } from '@dongkseo/contracts';
import { toLLMMessages } from './transcript-mapping.js';
import type { Compactor } from './compaction.js';

export interface TranscriptMemoryProviderOptions {
  compactor?: Compactor;
}

export class TranscriptMemoryProvider implements MemoryProvider {
  constructor(
    private readonly store: TranscriptStore,
    private readonly conversationId: string,
    private readonly opts: TranscriptMemoryProviderOptions = {},
  ) {}

  async getHistory(limit?: number): Promise<LLMMessage[]> {
    const entries = [];
    for await (const e of this.store.getEntries(this.conversationId, limit ? { limit } : undefined)) {
      entries.push(e);
    }
    return toLLMMessages(entries, (ref, mediaType) =>
      this.store.getAttachment(this.conversationId, ref).then(buf =>
        buf ? buf.toString('base64') : null,
      ).then(d => { void mediaType; return d; }),
    );
  }

  // The runtime recorder is the single writer; the architecture no longer appends.
  async append(_message: LLMMessage): Promise<void> { /* no-op */ }

  async compact(): Promise<string | null> {
    if (!this.opts.compactor) return null;
    const entries: TranscriptEntry[] = [];
    for await (const e of this.store.getEntries(this.conversationId)) entries.push(e);
    if (entries.length === 0) return null;

    // Project rich history → text ChatMessage[] for the text-based compactor.
    const rich = await toLLMMessages(entries, async () => null);
    const text: ChatMessage[] = rich
      .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool_result')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content
                .map((b) =>
                  b.type === 'text' ? b.text
                  : b.type === 'tool_call' ? `[tool:${b.name}]`
                  : b.type === 'tool_result' ? `[result] ${typeof b.content === 'string' ? b.content : ''}`
                  : '',
                )
                .join(' '),
      }));

    const result = await this.opts.compactor.compact(text);
    if (!result) return null;

    // Mark a supersede boundary: everything up to the current leaf is replaced by this summary.
    const lastUuid = entries[entries.length - 1].uuid;
    await this.store.appendEntry({
      type: 'summary',
      uuid: randomUUID(),
      parentUuid: lastUuid,
      conversationId: this.conversationId,
      schemaVersion: 'v2',
      timestamp: new Date().toISOString(),
      summary: result.summary,
      supersedesUpToUuid: lastUuid,
    });
    return result.summary;
  }

  async clear(): Promise<void> {
    await this.store.deleteConversation(this.conversationId);
  }
}
