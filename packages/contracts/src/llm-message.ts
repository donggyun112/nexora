import type { LLMMessage, LLMContentBlock } from './agent.js';

export function sanitizeToolPairsInPlace(history: LLMMessage[]): void {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const msg of history) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as LLMContentBlock[]) {
        if (block.type === 'tool_call') callIds.add(block.id);
      }
    }
    if (msg.role === 'tool_result' && Array.isArray(msg.content)) {
      for (const block of msg.content as LLMContentBlock[]) {
        if (block.type === 'tool_result') resultIds.add(block.id);
      }
    }
  }

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'tool_result' || !Array.isArray(msg.content)) continue;
    const blocks = msg.content as LLMContentBlock[];
    const surviving = blocks.filter(
      b => b.type !== 'tool_result' || callIds.has(b.id),
    );
    if (surviving.length === 0) {
      history.splice(i, 1);
    } else if (surviving.length !== blocks.length) {
      msg.content = surviving;
    }
  }

  const orphanedIds = new Set([...callIds].filter(id => !resultIds.has(id)));
  if (orphanedIds.size === 0) return;

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const orphansInMsg = (msg.content as LLMContentBlock[])
      .filter(b => b.type === 'tool_call' && orphanedIds.has(b.id))
      .map(b => (b as { id: string }).id);

    if (orphansInMsg.length === 0) continue;

    const stubMsg: LLMMessage = {
      role: 'tool_result',
      content: orphansInMsg.map(id => ({
        type: 'tool_result' as const,
        id,
        content: '[result lost during context compaction]',
        isError: false,
      })),
    };

    history.splice(i + 1, 0, stubMsg);
    i++;

    for (const id of orphansInMsg) orphanedIds.delete(id);
  }
}

export function imageResultForLLM(result: unknown): Extract<LLMContentBlock, { type: 'image' }> | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { type?: string; data?: string; mimeType?: string };
  if (r.type !== 'image' || typeof r.data !== 'string' || typeof r.mimeType !== 'string') return null;
  return { type: 'image', data: r.data, mimeType: r.mimeType };
}
