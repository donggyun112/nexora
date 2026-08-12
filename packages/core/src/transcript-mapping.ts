import type {
  LLMMessage, LLMContentBlock, ContentBlock, TranscriptEntry,
} from '@dongkseo/contracts';
import { sanitizeToolPairsInPlace } from '@dongkseo/contracts';

/** LLMContentBlock[] (or string) → transcript ContentBlock[]. Images are NOT handled here. */
export function llmContentToBlocks(content: string | LLMContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((b): ContentBlock => {
    switch (b.type) {
      case 'text': return { type: 'text', text: b.text };
      case 'tool_call': return { type: 'tool_use', id: b.id, name: b.name, input: b.arguments };
      case 'tool_result': return { type: 'tool_result', tool_use_id: b.id, content: b.content, is_error: b.isError ?? false };
      case 'image': throw new Error('llmContentToBlocks: image blocks must be stored via putAttachment by the recorder');
    }
  });
}

function blocksToLLMContent(blocks: ContentBlock[]): LLMContentBlock[] {
  const out: LLMContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') out.push({ type: 'tool_call', id: b.id, name: b.name, arguments: b.input });
    else if (b.type === 'tool_result') {
      const content = typeof b.content === 'string' ? b.content : b.content.map(c => (c.type === 'text' ? c.text : '[image]')).join('');
      out.push({ type: 'tool_result', id: b.tool_use_id, content, isError: b.is_error ?? false });
    }
  }
  return out;
}

/** Replay transcript entries → rich LLM messages. Applies summary supersede, resolves images, sanitizes tool pairs. */
export async function toLLMMessages(
  entries: TranscriptEntry[],
  resolveImage: (ref: string, mediaType: string) => Promise<string | null>,
): Promise<LLMMessage[]> {
  // 1. Apply the LAST summary's supersede boundary.
  let kept = entries;
  const summaries = entries.filter((e): e is Extract<TranscriptEntry, { type: 'summary' }> => e.type === 'summary');
  const lastSummary = summaries[summaries.length - 1];
  const messages: LLMMessage[] = [];
  if (lastSummary) {
    const cutIdx = entries.findIndex(e => e.uuid === lastSummary.supersedesUpToUuid);
    kept = entries.slice(cutIdx + 1);
    messages.push({ role: 'user', content: lastSummary.summary });
  }

  // 2. Map each content entry, resolving image blocks via the injected resolver.
  for (const e of kept) {
    if (e.type === 'summary' || e.type === 'attachment' || e.type === 'system') continue;
    const content: LLMContentBlock[] = blocksToLLMContent(e.content);
    for (const b of e.content) {
      if (b.type === 'image') {
        if (b.source.type === 'attachment_ref') {
          const data = await resolveImage(b.source.ref, b.source.media_type);
          if (data) content.push({ type: 'image', data, mimeType: b.source.media_type });
        } else if (b.source.type === 'base64') {
          content.push({ type: 'image', data: b.source.data, mimeType: b.source.media_type });
        }
      }
    }
    const inputId = typeof e.metadata?.inputId === 'string'
      ? e.metadata.inputId
      : undefined;
    messages.push({
      ...(inputId ? { id: inputId } : {}),
      role: e.type === 'assistant' ? 'assistant' : roleForUserEntry(e.content),
      content,
    });
  }

  // 3. Drop dangling tool pairs so the provider never 400s.
  sanitizeToolPairsInPlace(messages);
  return messages;
}

/** A user entry carrying tool_result blocks must use role 'tool_result'; otherwise 'user'. */
function roleForUserEntry(blocks: ContentBlock[]): 'user' | 'tool_result' {
  return blocks.some(b => b.type === 'tool_result') ? 'tool_result' : 'user';
}
