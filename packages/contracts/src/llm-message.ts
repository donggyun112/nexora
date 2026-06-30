import type { LLMMessage, LLMContentBlock } from './agent.js';

type ToolResultBlock = Extract<LLMContentBlock, { type: 'tool_result' }>;

/**
 * Rebuilds `history` in place so tool_call/tool_result pairs are not just present
 * but ADJACENT: every assistant message carrying tool_call blocks is immediately
 * followed by a single tool_result message holding the result for each of its
 * calls (in call order). This is what the provider (via pi-ai) actually requires —
 * a tool_use turn must be answered by the very next user/tool_result turn.
 *
 * - Missing result   → stub `[result lost during context compaction]`.
 * - Scattered results (split across messages, e.g. suspend/resume of parallel
 *   calls) → merged into the one adjacent message.
 * - Interleaved user/system messages → slide after the tool_result run.
 * - Orphaned results (no matching call) and duplicate tool_call ids → dropped.
 *
 * NOTE: pi-ai's transformMessages already stubs orphaned calls and forward-inserts
 * results when a user interrupts the tool flow, so the stubbing here overlaps with
 * it. The overlap is intentional, not dead code: this runs at the transcript-replay
 * boundary (the system of record), so the history must be self-consistent for ANY
 * downstream consumer — not only pi-ai. pi-ai also CANNOT pull a real late/scattered
 * result back adjacent (it only forward-inserts), so the reorder/merge below covers
 * a gap pi-ai leaves. Removing this to "delegate to pi-ai" would reintroduce the
 * suspend/resume 400. See the A/B/C analysis from 2026-06-26.
 */
export function sanitizeToolPairsInPlace(history: LLMMessage[]): void {
  // First result wins per id; later duplicates are dropped.
  const resultById = new Map<string, ToolResultBlock>();
  for (const msg of history) {
    if (msg.role !== 'tool_result' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as LLMContentBlock[]) {
      if (block.type === 'tool_result' && !resultById.has(block.id)) {
        resultById.set(block.id, block);
      }
    }
  }

  const out: LLMMessage[] = [];
  const consumed = new Set<string>();

  for (const msg of history) {
    // Drop standalone tool_result messages: their blocks are re-emitted next to
    // the owning assistant below; anything left over is an orphan to discard.
    if (msg.role === 'tool_result') continue;

    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    // Strip duplicate tool_call ids (a later repeat of an already-seen id would
    // make the provider reject "tool_use ids must be unique").
    const blocks = msg.content as LLMContentBlock[];
    const ids: string[] = [];
    const survivingBlocks = blocks.filter(b => {
      if (b.type !== 'tool_call') return true;
      if (consumed.has(b.id)) return false;
      ids.push(b.id);
      consumed.add(b.id);
      return true;
    });

    out.push(
      survivingBlocks.length === blocks.length
        ? msg
        : { ...msg, content: survivingBlocks },
    );

    if (ids.length === 0) continue;

    out.push({
      role: 'tool_result',
      content: ids.map(
        id =>
          resultById.get(id) ?? {
            type: 'tool_result' as const,
            id,
            content: '[result lost during context compaction]',
            isError: false,
          },
      ),
    });
  }

  history.splice(0, history.length, ...out);
}

export function imageResultForLLM(result: unknown): Extract<LLMContentBlock, { type: 'image' }> | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { type?: string; data?: string; mimeType?: string };
  if (r.type !== 'image' || typeof r.data !== 'string' || typeof r.mimeType !== 'string') return null;
  return { type: 'image', data: r.data, mimeType: r.mimeType };
}

/**
 * All image blocks carried by a tool result, in order: a single `image` result
 * yields one block; a `content` result yields one per image block it holds.
 * Used by the transcript recorder to attach every image a tool returns.
 */
export function imageBlocksFromResult(result: unknown): Array<Extract<LLMContentBlock, { type: 'image' }>> {
  if (!result || typeof result !== 'object') return [];
  const r = result as { type?: string; blocks?: unknown };
  if (r.type === 'content' && Array.isArray(r.blocks)) {
    const out: Array<Extract<LLMContentBlock, { type: 'image' }>> = [];
    for (const block of r.blocks) {
      const img = imageResultForLLM(block);
      if (img) out.push(img);
    }
    return out;
  }
  const single = imageResultForLLM(result);
  return single ? [single] : [];
}
