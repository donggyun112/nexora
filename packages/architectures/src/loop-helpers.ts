/**
 * loop-helpers — ReAct 계열 아키텍처가 공유하는 도구 실행 / history 위생 헬퍼.
 *
 * react.ts 와 deep-research.ts 가 동일한 도구 호출 처리·tool-pair sanitize 로직을
 * 공유한다. 한 곳에서 고치면 두 아키텍처 모두 반영된다.
 */

import { Buffer } from 'node:buffer';
import type {
  AgentInput,
  LLMContentBlock,
  LLMMessage,
  LLMResponse,
  RuntimeServices,
  ToolBatchResult,
} from '@dongkseo/contracts';

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

/**
 * 한 턴 내부 history 압축 옵션. 임계값은 토큰(문자/4 휴리스틱) 기준.
 * 모두 선택 — 미지정이면 TwoStageCompactor 와 동일한 기본값.
 */
export interface LoopCompactionOptions {
  /** 컨텍스트 윈도우 (토큰). 기본 200_000 */
  contextWindow?: number;
  /** 시스템 프롬프트 + 응답 예약 토큰. 기본 16_384 */
  reserveTokens?: number;
  /** 압축해도 건드리지 않을 최근 tail (토큰). 기본 20_000 */
  keepRecentTokens?: number;
  /** 이 길이보다 긴 tool_result content 만 프루닝 대상. 기본 4_000자 */
  toolResultTruncateChars?: number;
}

const PRUNE_PLACEHOLDER = '[older tool output pruned to fit context]';
const IMAGE_TOKEN_ESTIMATE = 1024;
const MAX_INLINE_FILE_CHARS = 64_000;
const TEXT_FILE_MIME_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/typescript',
  'application/x-javascript',
  'application/x-ndjson',
  'application/xml',
  'application/yaml',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/xml',
  'text/yaml',
]);
const TEXT_FILE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.log',
  '.md',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

export function userContentForInput(
  input: AgentInput,
  promptText = input.prompt,
): string | LLMContentBlock[] {
  const text = appendInputFileSummaries(promptText, input.files);
  const imageBlocks: Extract<LLMContentBlock, { type: 'image' }>[] = [];

  for (const img of input.images ?? []) {
    imageBlocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  }
  for (const file of input.files ?? []) {
    if (isImageMime(file.mimeType)) {
      imageBlocks.push({ type: 'image', data: file.data, mimeType: file.mimeType });
    }
  }

  if (imageBlocks.length === 0) return text;
  return [{ type: 'text', text }, ...imageBlocks];
}

function appendInputFileSummaries(
  promptText: string,
  files: AgentInput['files'] | undefined,
): string {
  if (!files?.length) return promptText;

  const parts: string[] = ['Attached files:'];
  for (const file of files) {
    const label = fileLabel(file);
    if (isImageMime(file.mimeType)) {
      parts.push(`- ${label}: image attached as visual context.`);
      continue;
    }

    if (!isTextLikeFile(file)) {
      parts.push(`- ${label}: binary content not inlined.`);
      continue;
    }

    const text = decodeFileText(file.data);
    if (text === null) {
      parts.push(`- ${label}: text-like file could not be decoded as UTF-8.`);
      continue;
    }

    parts.push(`--- ${label} ---\n${truncateInlineFileText(text)}\n--- end ${label} ---`);
  }

  const attachmentText = parts.join('\n\n');
  return promptText ? `${promptText}\n\n${attachmentText}` : attachmentText;
}

function fileLabel(file: NonNullable<AgentInput['files']>[number]): string {
  const name = file.name ? `"${file.name}"` : 'unnamed file';
  const size = typeof file.size === 'number' ? `, ${file.size} bytes` : '';
  return `${name} (${file.mimeType}${size})`;
}

function isImageMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('image/');
}

function isTextLikeFile(file: NonNullable<AgentInput['files']>[number]): boolean {
  const mimeType = file.mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  if (mimeType.startsWith('text/')) return true;
  if (TEXT_FILE_MIME_TYPES.has(mimeType)) return true;
  const name = file.name?.toLowerCase() ?? '';
  return [...TEXT_FILE_EXTENSIONS].some(ext => name.endsWith(ext));
}

function decodeFileText(data: string): string | null {
  try {
    const base64 = stripDataUrlPrefix(data).replace(/\s+/g, '');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.includes(0)) return null;
    const text = buffer.toString('utf-8');
    const replacementChars = text.match(/\uFFFD/g)?.length ?? 0;
    if (replacementChars > Math.max(3, Math.floor(text.length * 0.01))) return null;
    return text;
  } catch {
    return null;
  }
}

function stripDataUrlPrefix(data: string): string {
  const match = /^data:[^;]+;base64,(.+)$/i.exec(data.trim());
  return match ? match[1] : data;
}

function truncateInlineFileText(text: string): string {
  if (text.length <= MAX_INLINE_FILE_CHARS) return text;
  return `${text.slice(0, MAX_INLINE_FILE_CHARS)}\n[truncated ${text.length - MAX_INLINE_FILE_CHARS} chars]`;
}

function estimateBlockTokens(content: LLMMessage['content']): number {
  if (typeof content === 'string') return Math.ceil(content.length / 4);
  let total = 0;
  for (const b of content as LLMContentBlock[]) {
    if (b.type === 'text') total += Math.ceil(b.text.length / 4);
    else if (b.type === 'tool_call') total += Math.ceil(JSON.stringify(b.arguments).length / 4);
    else if (b.type === 'tool_result') total += Math.ceil(b.content.length / 4);
    else if (b.type === 'image') total += IMAGE_TOKEN_ESTIMATE;
  }
  return total;
}

function estimateHistoryTokens(history: LLMMessage[]): number {
  return history.reduce((sum, m) => sum + estimateBlockTokens(m.content), 0);
}

/**
 * 한 턴 내부에서 누적된 로컬 history 를 in-place 로 프루닝한다. LLM 호출 없는 결정적 동작.
 *
 * 추정 토큰이 (contextWindow - reserveTokens) 이하면 아무것도 안 하고 false.
 * 초과하면 최근 keepRecentTokens 분량 tail 을 보호한 채, 오래된 것부터 큰 tool_result
 * content 를 placeholder 로 치환해 임계 밑으로 내린다. 프루닝했으면 true.
 *
 * tool_result 의 id·블록 구조는 그대로 두고 content 문자열만 줄이므로 tool_call↔tool_result
 * 짝은 항상 유효하다. placeholder 는 짧아 재호출 시 다시 대상이 되지 않는다(idempotent).
 *
 * 가장 최근 tool_result 가 유일한 후보면(= tail 보호 영역) 줄이지 않는다 — 최근 컨텍스트를
 * 한 턴 내 안전보다 우선한다.
 */
export function pruneLoopHistory(history: LLMMessage[], opts: LoopCompactionOptions = {}): boolean {
  const contextWindow = opts.contextWindow ?? 200_000;
  const reserveTokens = opts.reserveTokens ?? 16_384;
  const keepRecentTokens = opts.keepRecentTokens ?? 20_000;
  const truncateChars = opts.toolResultTruncateChars ?? 4_000;
  const threshold = contextWindow - reserveTokens;

  if (estimateHistoryTokens(history) <= threshold) return false;

  // 최근 tail 보호 경계: 끝에서부터 토큰을 누적해 keepRecentTokens 를 덮는 첫 index.
  // [protectedFrom, end) 는 보호 — 최소한 마지막 메시지는 항상 보호된다.
  let tailTokens = 0;
  let protectedFrom = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    protectedFrom = i;
    tailTokens += estimateBlockTokens(history[i].content);
    if (tailTokens >= keepRecentTokens) break;
  }

  let pruned = false;
  for (let i = 0; i < protectedFrom; i++) {
    if (estimateHistoryTokens(history) <= threshold) break;
    const msg = history[i];
    if (msg.role !== 'tool_result' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as LLMContentBlock[]) {
      if (block.type === 'tool_result' && block.content.length > truncateChars) {
        block.content = PRUNE_PLACEHOLDER;
        pruned = true;
      }
    }
  }
  return pruned;
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
