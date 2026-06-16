/**
 * loop-helpers — ReAct 계열 아키텍처가 공유하는 도구 실행 / history 위생 헬퍼.
 *
 * react.ts 와 deep-research.ts 가 동일한 도구 호출 처리·tool-pair sanitize 로직을
 * 공유한다. 한 곳에서 고치면 두 아키텍처 모두 반영된다.
 */

import type {
  LLMContentBlock,
  LLMMessage,
  LLMResponse,
  RuntimeServices,
  ToolBatchResult,
} from '@nexora/contracts';

export type ToolCall = NonNullable<LLMResponse['toolCalls']>[number];

export async function executeToolCalls(
  services: RuntimeServices,
  toolCalls: ToolCall[],
): Promise<{ tc: ToolCall; result: unknown; isError: boolean }[]> {
  if (services.tools.executeBatch) {
    const batchResults = await services.tools.executeBatch(
      toolCalls.map(tc => ({ callId: tc.id, name: tc.name, input: tc.arguments })),
      services.signal,
    );
    return mergeBatchResults(toolCalls, batchResults);
  }

  const results: { tc: ToolCall; result: unknown; isError: boolean }[] = [];
  for (const tc of toolCalls) {
    if (services.signal.aborted) break;
    const result = await services.tools.execute(tc.name, tc.id, tc.arguments, services.signal);
    results.push({ tc, result, isError: isErrorResult(result) });
  }
  return results;
}

function mergeBatchResults(
  toolCalls: ToolCall[],
  batchResults: ToolBatchResult[],
): { tc: ToolCall; result: unknown; isError: boolean }[] {
  const byId = new Map(batchResults.map(result => [result.callId, result]));
  return toolCalls.map((tc) => {
    const result = byId.get(tc.id);
    if (!result) {
      return {
        tc,
        result: { type: 'error' as const, message: `Missing tool result: ${tc.id}` },
        isError: true,
      };
    }
    return { tc, result: result.result, isError: result.isError };
  });
}

/**
 * Sanitize tool_call/tool_result pairs in-place after compaction.
 * Ensures every tool_call has a matching tool_result (prevents API crashes).
 */
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

export function isErrorResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  return (result as { type?: string }).type === 'error';
}

export function formatResultForLLM(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result);
  const r = result as { type?: string; text?: string; message?: string };
  if (r.type === 'text' && typeof r.text === 'string') return r.text;
  if (r.type === 'error' && typeof r.message === 'string') return `[ERROR] ${r.message}`;
  if (r.type === 'image') return '[image]';
  return JSON.stringify(result);
}

export function imageResultForLLM(result: unknown): Extract<LLMContentBlock, { type: 'image' }> | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { type?: string; data?: string; mimeType?: string };
  if (r.type !== 'image' || typeof r.data !== 'string' || typeof r.mimeType !== 'string') return null;
  return { type: 'image', data: r.data, mimeType: r.mimeType };
}
