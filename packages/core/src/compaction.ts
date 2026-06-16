/**
 * Compactor — 2단계 컨텍스트 압축.
 *
 * Stage 1: truncateLargeToolResults — 큰 도구 결과를 잘라냄 (lightweight)
 * Stage 2: generateSummary — LLM 호출로 의미 있는 요약 생성
 *
 * 참고: reference compaction.ts (pi-coding-agent 포팅)
 */

import type {
  ChatMessage,
  LLMProvider,
  LLMMessage,
  LLMContentBlock,
} from '@nexora/contracts';

// ─── 상수 ──────────────────────────────────────────────────────────────────
const DEFAULT_CONTEXT_WINDOW = 256_000;
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_TOOL_RESULT_TRUNCATE_CHARS = 4_000;

const SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n';
const SUMMARY_SUFFIX = '\n</summary>';

// ─── 프롬프트 ──────────────────────────────────────────────────────────────
const SUMMARIZATION_SYSTEM_PROMPT =
  'You are a context summarization assistant. Your task is to read a conversation between a user and an AI agent, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.';

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages

Use the same format as the previous summary. Keep each section concise.`;

// ─── 설정 ──────────────────────────────────────────────────────────────────

export interface CompactorOptions {
  /** 요약에 사용할 LLM provider */
  llm: LLMProvider;
  /** 컨텍스트 윈도우 (기본 200k) */
  contextWindow?: number;
  /** 시스템 프롬프트 + 응답을 위해 예약할 토큰 (기본 16k) */
  reserveTokens?: number;
  /** 압축 시 유지할 최근 토큰 (기본 20k) */
  keepRecentTokens?: number;
  /** Stage 1에서 도구 결과를 자를 최대 길이 (기본 4000자) */
  toolResultTruncateChars?: number;
  /** 압축에 사용할 모델 */
  model?: string;
  /** 압축 완료 콜백 */
  onCompactionComplete?: (summary: string) => void | Promise<void>;
  /**
   * Hook called before compaction starts. Receives the original messages.
   * Use to extract critical tags/context that must survive compaction.
   * Return value is passed to afterCompact.
   */
  beforeCompact?: (messages: ChatMessage[]) => unknown;
  /**
   * Hook called after compaction. Receives the compacted messages and
   * the value returned by beforeCompact. Use to re-inject preserved tags.
   */
  afterCompact?: (messages: ChatMessage[], preserved: unknown) => ChatMessage[];
  /**
   * Selective tool output compression: only messages with role 'assistant'
   * containing tool output longer than this threshold are truncated in Stage 1.
   * Shorter messages are left intact. Default: same as toolResultTruncateChars.
   * Set to Infinity to skip selective compression.
   */
  selectiveToolThreshold?: number;
}

export interface CompactionResult {
  summary: string;
  newMessages: ChatMessage[];
  /** 압축 전 메시지 수 */
  beforeCount: number;
  /** 압축 후 메시지 수 */
  afterCount: number;
  /** 압축 전 토큰 추정 */
  beforeTokens: number;
  /** 압축 후 토큰 추정 */
  afterTokens: number;
}

// ─── 토큰 추정 ──────────────────────────────────────────────────────────────

/** chars/4 휴리스틱 (보수적) */
export function estimateTokens(message: ChatMessage): number {
  return Math.ceil(message.content.length / 4);
}

export function estimateContextSize(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) total += estimateTokens(msg);
  return total;
}

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  reserveTokens: number,
): boolean {
  return contextTokens > contextWindow - reserveTokens;
}

// ─── Stage 0: Tool output pruning (hermes _prune_old_tool_results) ─────

const PRUNED_TOOL_PLACEHOLDER = '[Old tool output cleared to save context space]';

/**
 * Cheap pre-pass: replace old tool results with a placeholder.
 * Protects the most recent `protectTailCount` messages.
 * Only targets assistant messages that look like tool output (long + structured).
 * No LLM call — pure string replacement.
 */
export function pruneOldToolOutputs(
  messages: ChatMessage[],
  protectTailCount: number,
): ChatMessage[] {
  if (messages.length <= protectTailCount) return messages;
  const cutoff = messages.length - protectTailCount;
  return messages.map((msg, i) => {
    if (i >= cutoff) return msg;
    if (msg.role !== 'assistant') return msg;
    if (msg.content.length < 500) return msg;
    // Only prune messages that look like tool output, not conversational replies.
    // Tool output typically contains: JSON, code blocks, file paths, or structured data.
    if (!looksLikeToolOutput(msg.content)) return msg;
    return { ...msg, content: PRUNED_TOOL_PLACEHOLDER };
  });
}

/** Heuristic: does this content look like tool output rather than a conversational reply? */
function looksLikeToolOutput(content: string): boolean {
  // Check first 500 chars for structural indicators
  const head = content.slice(0, 500);
  return (
    head.includes('```') ||           // code block
    head.includes('tool_result') ||   // serialized tool result
    head.includes('tool_call') ||     // serialized tool call
    /^\s*[{[]/.test(head) ||          // starts with JSON
    /^\/[\w./-]+/.test(head) ||       // starts with file path
    (head.split('\n').length > 10 && head.includes('  '))  // many indented lines
  );
}

// ─── Stage 1: 도구 결과 절단 ───────────────────────────────────────────────

/**
 * 메시지 배열에서 큰 텍스트 블록을 truncate.
 * ChatMessage는 string content만 가지므로, 매우 긴 메시지를 자른다.
 */
export function truncateLargeContent(
  messages: ChatMessage[],
  maxChars: number,
): ChatMessage[] {
  return messages.map(msg => {
    if (msg.content.length <= maxChars) return msg;
    return {
      ...msg,
      content: msg.content.slice(0, maxChars) + `\n\n…[truncated ${msg.content.length - maxChars} chars]`,
    };
  });
}

/**
 * Selective tool output compression — only compress assistant messages
 * that look like tool output (long content, often containing code blocks
 * or structured data). Short conversational messages are left intact.
 *
 * This is more nuanced than truncateLargeContent: it preserves the first
 * and last portions of long outputs to keep headers/summaries visible.
 */
export function compressToolOutputs(
  messages: ChatMessage[],
  threshold: number,
): ChatMessage[] {
  return messages.map(msg => {
    // Only compress assistant messages (likely tool output).
    // User messages are left intact to preserve constraints/instructions.
    if (msg.role !== 'assistant') return msg;
    if (msg.content.length <= threshold) return msg;
    // Keep first 30% and last 20% of content for context
    const keepHead = Math.floor(threshold * 0.6);
    const keepTail = Math.floor(threshold * 0.3);
    const omitted = msg.content.length - keepHead - keepTail;
    return {
      ...msg,
      content:
        msg.content.slice(0, keepHead) +
        `\n\n…[compressed ${omitted} chars — head+tail preserved]…\n\n` +
        msg.content.slice(-keepTail),
    };
  });
}

// ─── Tool pair sanitization ────────────────────────────────────────────────

/**
 * Sanitize tool call/result pairs in LLMMessage[] history.
 *
 * Anthropic/OpenAI APIs require that every tool_call has a matching tool_result
 * and vice versa. After compaction cut-point splitting, orphans can appear.
 *
 * This operates on structured LLMMessage[] (not ChatMessage[]) so it can
 * inspect actual tool_call/tool_result blocks, not just string content.
 *
 * Fix strategy (matches Hermes _sanitize_tool_pairs):
 * 1. Collect all tool_call IDs from assistant content blocks
 * 2. Collect all tool_result IDs from tool_result messages
 * 3. Remove orphaned tool_result messages (no matching call)
 * 4. Insert stub tool_result for orphaned tool_calls
 */
export function sanitizeLLMToolPairs(messages: LLMMessage[]): LLMMessage[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  // Pass 1: collect tool_call IDs
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_call') callIds.add(block.id);
    }
  }

  // Pass 2: collect tool_result IDs
  for (const msg of messages) {
    if (msg.role !== 'tool_result' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') resultIds.add(block.id);
    }
  }

  // Pass 3: remove orphaned tool_result messages
  const cleaned = messages.filter(msg => {
    if (msg.role !== 'tool_result' || typeof msg.content === 'string') return true;
    const blocks = msg.content.filter(
      (b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result',
    );
    if (blocks.length === 0) return true;
    // Keep if at least one result has a matching call
    return blocks.some(b => callIds.has(b.id));
  });

  // Pass 4: find orphaned calls and insert stub results
  const orphanedIds = [...callIds].filter(id => !resultIds.has(id));
  if (orphanedIds.length === 0) return cleaned;

  const stubMessage: LLMMessage = {
    role: 'tool_result',
    content: orphanedIds.map(id => ({
      type: 'tool_result' as const,
      id,
      content: '[result lost during context compaction]',
      isError: false,
    })),
  };

  return [...cleaned, stubMessage];
}

/**
 * ChatMessage-level wrapper — for use in the compactor where we only have
 * ChatMessage[]. Scans string content for serialized tool IDs and inserts
 * placeholder stubs. Less precise than sanitizeLLMToolPairs but safe.
 */
export function sanitizeToolPairs(messages: ChatMessage[]): ChatMessage[] {
  // No-op if no messages reference tool interactions
  const hasToolContent = messages.some(m => m.content.includes('"tool_call"'));
  if (!hasToolContent) return messages;
  return messages; // Let sanitizeLLMToolPairs handle it at the LLM layer
}

// ─── Cut point 탐색 ───────────────────────────────────────────────────────

/**
 * 최근 keepRecentTokens 만큼 보존할 자르기 지점을 찾는다.
 * user 메시지 경계에서 자름.
 */
export function findCutPoint(messages: ChatMessage[], keepRecentTokens: number): number {
  let accumulated = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      // 이 지점 이후 가장 가까운 user 메시지에서 자름 (turn 경계)
      for (let j = i; j < messages.length; j++) {
        if (messages[j].role === 'user') return j;
      }
      return i;
    }
  }

  return 0;
}

// ─── 직렬화 (LLM이 대화를 이어가지 않도록) ────────────────────────────────

const SERIALIZE_CONTENT_MAX = 6000;
const SERIALIZE_CONTENT_HEAD = 4000;
const SERIALIZE_CONTENT_TAIL = 1500;

/**
 * Serialize conversation for summarization input.
 * Includes tool_call names and tool_result content (truncated).
 * Caps per-message content to prevent summarizer context overflow.
 */
function serializeConversation(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const hasToolContent = msg.content.includes('tool_result') || msg.content.includes('tool_call');
    const label = msg.role === 'user' ? 'User'
      : hasToolContent ? 'Assistant (tool interaction)'
      : 'Assistant';

    let content = msg.content;
    // Truncate oversized content to prevent summarizer overflow
    if (content.length > SERIALIZE_CONTENT_MAX) {
      content =
        content.slice(0, SERIALIZE_CONTENT_HEAD) +
        `\n…[truncated ${content.length - SERIALIZE_CONTENT_HEAD - SERIALIZE_CONTENT_TAIL} chars]…\n` +
        content.slice(-SERIALIZE_CONTENT_TAIL);
    }

    parts.push(`[${label}]: ${content}`);
  }
  return parts.join('\n\n');
}

// ─── Compactor ─────────────────────────────────────────────────────────────

export interface Compactor {
  compact(messages: ChatMessage[]): Promise<CompactionResult | null>;
}

export class TwoStageCompactor implements Compactor {
  private readonly llm: LLMProvider;
  private readonly contextWindow: number;
  private readonly reserveTokens: number;
  private readonly keepRecentTokens: number;
  private readonly toolResultTruncateChars: number;
  private readonly selectiveToolThreshold: number;
  private readonly model?: string;
  private readonly onCompactionComplete?: CompactorOptions['onCompactionComplete'];
  private readonly beforeCompact?: CompactorOptions['beforeCompact'];
  private readonly afterCompact?: CompactorOptions['afterCompact'];
  private previousSummary: string | undefined;
  private compacting = false;

  constructor(options: CompactorOptions) {
    this.llm = options.llm;
    this.contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.reserveTokens = options.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
    this.keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
    this.toolResultTruncateChars = options.toolResultTruncateChars ?? DEFAULT_TOOL_RESULT_TRUNCATE_CHARS;
    this.selectiveToolThreshold = options.selectiveToolThreshold ?? this.toolResultTruncateChars;
    this.model = options.model;
    this.onCompactionComplete = options.onCompactionComplete;
    this.beforeCompact = options.beforeCompact;
    this.afterCompact = options.afterCompact;
  }

  /**
   * 컨텍스트가 한계를 넘으면 압축, 아니면 null 반환.
   */
  async compact(messages: ChatMessage[]): Promise<CompactionResult | null> {
    if (this.compacting) return null;

    const beforeTokens = estimateContextSize(messages);
    if (!shouldCompact(beforeTokens, this.contextWindow, this.reserveTokens)) {
      return null;
    }

    this.compacting = true;
    try {
      // beforeCompact hook: extract critical tags/context before compression
      const preserved = this.beforeCompact?.(messages);

      // Stage 0: prune old tool outputs (cheap, no LLM call)
      const pruned = pruneOldToolOutputs(messages, Math.max(10, Math.floor(messages.length * 0.3)));
      const afterPrune = estimateContextSize(pruned);
      if (!shouldCompact(afterPrune, this.contextWindow, this.reserveTokens)) {
        const finalMessages = this.afterCompact ? this.afterCompact(pruned, preserved) : pruned;
        return {
          summary: '(stage 0 tool output pruning only)',
          newMessages: finalMessages,
          beforeCount: messages.length,
          afterCount: finalMessages.length,
          beforeTokens,
          afterTokens: estimateContextSize(finalMessages),
        };
      }

      // Stage 1a: selective tool output compression (head+tail preserved)
      const selective = compressToolOutputs(pruned, this.selectiveToolThreshold);
      // Stage 1b: hard truncation for anything still over limit
      const stage1 = truncateLargeContent(selective, this.toolResultTruncateChars);
      const afterStage1 = estimateContextSize(stage1);

      // Stage 1만으로 충분한가?
      if (!shouldCompact(afterStage1, this.contextWindow, this.reserveTokens)) {
        const finalMessages = this.afterCompact ? this.afterCompact(stage1, preserved) : stage1;
        return {
          summary: '(stage 1 truncation only)',
          newMessages: finalMessages,
          beforeCount: messages.length,
          afterCount: finalMessages.length,
          beforeTokens,
          afterTokens: estimateContextSize(finalMessages),
        };
      }

      // Stage 2: LLM 요약
      const cutIndex = findCutPoint(stage1, this.keepRecentTokens);
      if (cutIndex === 0) {
        // 모든 게 너무 큼 — 최소한 stage 1 결과 반환
        return {
          summary: '(unable to find cut point — used stage 1 only)',
          newMessages: stage1,
          beforeCount: messages.length,
          afterCount: stage1.length,
          beforeTokens,
          afterTokens: afterStage1,
        };
      }

      const toSummarize = stage1.slice(0, cutIndex);
      const recent = stage1.slice(cutIndex);

      let summary: string;
      try {
        summary = await this.generateSummary(toSummarize);
      } catch {
        // Summarization failed (LLM error, context overflow, etc.)
        // Use a static fallback instead of crashing the agent
        summary = '(Summary unavailable — continuing with truncated context. ' +
          `${toSummarize.length} messages were compressed.)`;
      }
      this.previousSummary = summary;

      const summaryMessage: ChatMessage = {
        role: 'user',
        content: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}`,
      };
      const rawMessages = [summaryMessage, ...recent];
      // Sanitize orphaned tool_call/result pairs to prevent API errors
      const sanitized = sanitizeToolPairs(rawMessages);
      const newMessages = this.afterCompact ? this.afterCompact(sanitized, preserved) : sanitized;

      if (this.onCompactionComplete) {
        try {
          await this.onCompactionComplete(summary);
        } catch {
          // 콜백 실패는 압축 자체를 망치지 않음
        }
      }

      return {
        summary,
        newMessages,
        beforeCount: messages.length,
        afterCount: newMessages.length,
        beforeTokens,
        afterTokens: estimateContextSize(newMessages),
      };
    } finally {
      this.compacting = false;
    }
  }

  private async generateSummary(messagesToSummarize: ChatMessage[]): Promise<string> {
    const conversationText = serializeConversation(messagesToSummarize);
    const basePrompt = this.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;

    let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
    if (this.previousSummary) {
      promptText += `<previous-summary>\n${this.previousSummary}\n</previous-summary>\n\n`;
    }
    promptText += basePrompt;

    const llmMessages: LLMMessage[] = [
      { role: 'user', content: promptText },
    ];

    const response = await this.llm.complete(llmMessages, {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      model: this.model,
      maxTokens: Math.floor(0.8 * this.reserveTokens),
    });

    return response.content;
  }
}
