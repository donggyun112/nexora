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
} from '@nexora/contracts';

// ─── 상수 ──────────────────────────────────────────────────────────────────
const DEFAULT_CONTEXT_WINDOW = 200_000;
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

function serializeConversation(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    parts.push(`[${label}]: ${msg.content}`);
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
  private readonly model?: string;
  private readonly onCompactionComplete?: CompactorOptions['onCompactionComplete'];
  private previousSummary: string | undefined;
  private compacting = false;

  constructor(options: CompactorOptions) {
    this.llm = options.llm;
    this.contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.reserveTokens = options.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
    this.keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
    this.toolResultTruncateChars = options.toolResultTruncateChars ?? DEFAULT_TOOL_RESULT_TRUNCATE_CHARS;
    this.model = options.model;
    this.onCompactionComplete = options.onCompactionComplete;
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
      // Stage 1: 큰 메시지 절단
      const stage1 = truncateLargeContent(messages, this.toolResultTruncateChars);
      const afterStage1 = estimateContextSize(stage1);

      // Stage 1만으로 충분한가?
      if (!shouldCompact(afterStage1, this.contextWindow, this.reserveTokens)) {
        return {
          summary: '(stage 1 truncation only)',
          newMessages: stage1,
          beforeCount: messages.length,
          afterCount: stage1.length,
          beforeTokens,
          afterTokens: afterStage1,
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
      const summary = await this.generateSummary(toSummarize);
      this.previousSummary = summary;

      const summaryMessage: ChatMessage = {
        role: 'user',
        content: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}`,
      };
      const newMessages = [summaryMessage, ...recent];

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
