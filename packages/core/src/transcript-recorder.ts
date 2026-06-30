import { randomUUID } from 'node:crypto';
import type {
  TranscriptStore,
  TranscriptEntry,
  AgentInput,
  AgentEvent,
  ContentBlock,
  ImageContent,
} from '@dongkseo/contracts';
import { imageBlocksFromResult } from '@dongkseo/contracts';

export class TranscriptRecorder {
  private lastUuid: string | null = null;
  private pendingText = '';
  private pendingToolUses: ContentBlock[] = [];
  private pendingToolResults: ContentBlock[] = [];
  private mode: 'idle' | 'collecting-results' = 'idle';
  // How many tool_results the current round expects (= tool_use count of the
  // just-flushed assistant message) and how many have arrived. Once they match,
  // the grouped tool_result entry is written immediately rather than lagging to
  // the next step — so an interrupt after a round still keeps that round durable.
  private expectedResults = 0;
  private collectedResults = 0;

  constructor(
    private readonly store: TranscriptStore,
    private readonly conversationId: string,
  ) {}

  private base() {
    return {
      conversationId: this.conversationId,
      schemaVersion: 'v2' as const,
      timestamp: new Date().toISOString(),
    };
  }

  private async write(entry: TranscriptEntry): Promise<void> {
    this.lastUuid = entry.uuid;
    try { await this.store.appendEntry(entry); } catch { /* best-effort */ }
  }

  async recordUserInput(input: AgentInput): Promise<void> {
    const content: ContentBlock[] = [{ type: 'text', text: input.prompt }];
    for (const img of input.images ?? []) {
      const block = await this.imageBlock(img);
      if (block) content.push(block);
    }
    await this.write({
      ...this.base(),
      type: 'user',
      uuid: randomUUID(),
      parentUuid: this.lastUuid,
      content,
    });
  }

  async recordSteer(text: string): Promise<void> {
    await this.flushPendingToolResults();
    await this.flushPendingAssistant();
    await this.write({
      ...this.base(),
      type: 'user',
      uuid: randomUUID(),
      parentUuid: this.lastUuid,
      content: [{ type: 'text', text }],
    });
  }

  async onEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'text':
        if (this.mode === 'collecting-results') await this.flushPendingToolResults();
        this.pendingText += event.text;
        break;

      case 'tool_call':
        if (this.mode === 'collecting-results') await this.flushPendingToolResults();
        this.pendingToolUses.push({
          type: 'tool_use',
          id: event.id,
          name: event.name,
          input: event.input,
        });
        break;

      case 'tool_result': {
        if (this.mode !== 'collecting-results') {
          // Capture the round size before flushPendingAssistant clears pendingToolUses.
          this.expectedResults = this.pendingToolUses.length;
          this.collectedResults = 0;
          await this.flushPendingAssistant();
          this.mode = 'collecting-results';
        }
        // Always push the tool_result text block first
        this.pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: event.id,
          content: stringifyResult(event.result),
          is_error: event.isError,
        });
        // Attach every image the result carries (one for an `image` result,
        // possibly many for a `content` result e.g. PDF pages / notebook cells).
        for (const img of imageBlocksFromResult(event.result)) {
          const block = await this.imageBlock({ type: 'image', data: img.data, mimeType: img.mimeType });
          if (block) this.pendingToolResults.push(block);
        }
        this.collectedResults += 1;
        // Round complete (every dispatched tool_use answered) → persist the
        // grouped tool_result entry now. Keeps parallel results in one entry
        // (replay-valid) while removing the wait-for-next-step durability gap.
        if (this.expectedResults > 0 && this.collectedResults >= this.expectedResults) {
          await this.flushPendingToolResults();
        }
        break;
      }

      case 'done':
        if (this.mode === 'collecting-results') await this.flushPendingToolResults();
        // If no text accumulated separately (tool-only turn after flushing), use done.content
        if (!this.pendingText && event.content) this.pendingText = event.content;
        await this.flushPendingAssistant({
          model: event.model,
          usage: event.usage,
        });
        break;

      default:
        // thinking / progress / artifact / suspended / error not persisted as turns
        break;
    }
  }

  private async flushPendingAssistant(meta?: {
    model?: string;
    usage?: { promptTokens?: number; completionTokens?: number };
  }): Promise<void> {
    if (!this.pendingText && this.pendingToolUses.length === 0) return;
    const content: ContentBlock[] = [];
    if (this.pendingText) content.push({ type: 'text', text: this.pendingText });
    content.push(...this.pendingToolUses);
    await this.write({
      ...this.base(),
      type: 'assistant',
      uuid: randomUUID(),
      parentUuid: this.lastUuid,
      content,
      ...(meta?.model != null ? { model: meta.model } : {}),
      ...(meta?.usage != null
        ? {
            usage: {
              inputTokens: meta.usage.promptTokens,
              outputTokens: meta.usage.completionTokens,
            },
          }
        : {}),
    });
    this.pendingText = '';
    this.pendingToolUses = [];
  }

  private async flushPendingToolResults(): Promise<void> {
    if (this.pendingToolResults.length === 0) {
      this.mode = 'idle';
      return;
    }
    await this.write({
      ...this.base(),
      type: 'user',
      uuid: randomUUID(),
      parentUuid: this.lastUuid,
      content: this.pendingToolResults,
    });
    this.pendingToolResults = [];
    this.mode = 'idle';
  }

  private async imageBlock(img: ImageContent): Promise<ContentBlock | null> {
    try {
      const buf = Buffer.from(img.data, 'base64');
      const ref = await this.store.putAttachment(this.conversationId, buf, img.mimeType);
      return {
        type: 'image',
        source: {
          type: 'attachment_ref',
          ref: ref.ref,
          media_type: img.mimeType,
        },
      };
    } catch {
      return null; // best-effort: a storage hiccup drops the image, never the turn
    }
  }

  async flush(): Promise<void> {
    await this.flushPendingToolResults();
    await this.flushPendingAssistant();
    await this.store.flush();
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const r = result as {
      type?: string;
      text?: string;
      message?: string;
      blocks?: Array<{ type?: string; text?: string }>;
    };
    if (r.type === 'text' && typeof r.text === 'string') return r.text;
    if (r.type === 'error' && typeof r.message === 'string') return `[ERROR] ${r.message}`;
    if (r.type === 'image') return '[image]';
    if (r.type === 'content' && Array.isArray(r.blocks)) {
      // Text summary for the tool_result block; the images are pushed separately
      // by the recorder as attachment blocks.
      return r.blocks
        .map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '[image]'))
        .join('\n');
    }
  }
  return JSON.stringify(result);
}
