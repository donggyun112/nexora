import type { TranscriptStore, LLMMessage } from '@dongkseo/contracts';
import { toLLMMessages } from './transcript-mapping.js';
import type { Compactor } from './compaction.js';

export interface TranscriptMemoryProviderOptions {
  compactor?: Compactor;
}

export class TranscriptMemoryProvider {
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
    // Summarize the current text projection, then mark a supersede boundary.
    // Detailed summary-entry write is implemented in Task 8 (compaction wiring); here it is a no-op stub returning null.
    return null;
  }

  async clear(): Promise<void> {
    await this.store.deleteConversation(this.conversationId);
  }
}
