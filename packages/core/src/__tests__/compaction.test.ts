import { describe, it, expect } from 'vitest';
import {
  TwoStageCompactor,
  estimateTokens,
  estimateContextSize,
  shouldCompact,
  truncateLargeContent,
  findCutPoint,
} from '../compaction.js';
import { MockLLMProvider } from './mock-llm.js';
import type { ChatMessage } from '@nexora/contracts';

describe('compaction utilities', () => {
  it('estimateTokens uses chars/4', () => {
    expect(estimateTokens({ role: 'user', content: 'a'.repeat(40) })).toBe(10);
  });

  it('estimateContextSize sums all messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a'.repeat(40) },
      { role: 'assistant', content: 'b'.repeat(80) },
    ];
    expect(estimateContextSize(messages)).toBe(30);
  });

  it('shouldCompact triggers when above threshold', () => {
    expect(shouldCompact(100, 1000, 100)).toBe(false);
    expect(shouldCompact(950, 1000, 100)).toBe(true);
  });

  it('truncateLargeContent shortens long messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'x'.repeat(100) },
    ];
    const result = truncateLargeContent(messages, 50);
    expect(result[0].content).toBe('short');
    expect(result[1].content.length).toBeLessThan(100);
    expect(result[1].content).toContain('truncated');
  });

  it('findCutPoint finds user-message boundary', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a'.repeat(40) },     // 10 tokens
      { role: 'assistant', content: 'b'.repeat(40) }, // 10 tokens
      { role: 'user', content: 'c'.repeat(40) },     // 10 tokens
      { role: 'assistant', content: 'd'.repeat(40) }, // 10 tokens
    ];
    // keep last 15 tokens → cut should land at user message (index 2)
    const idx = findCutPoint(messages, 15);
    expect(idx).toBe(2);
  });
});

describe('TwoStageCompactor', () => {
  it('returns null when context fits', async () => {
    const llm = new MockLLMProvider([]);
    const compactor = new TwoStageCompactor({
      llm,
      contextWindow: 1000,
      reserveTokens: 100,
    });

    const result = await compactor.compact([
      { role: 'user', content: 'short' },
    ]);
    expect(result).toBeNull();
    expect(llm.callLog).toHaveLength(0);
  });

  it('uses LLM summary when context overflows', async () => {
    const llm = new MockLLMProvider([
      { text: '## Goal\nTesting compaction\n\n## Progress\n- Done lots' },
    ]);

    const compactor = new TwoStageCompactor({
      llm,
      contextWindow: 200,
      reserveTokens: 50,
      keepRecentTokens: 30,
      toolResultTruncateChars: 1_000_000, // Stage 1 비활성화
    });

    // 약 250 토큰의 메시지
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'user', content: 'a'.repeat(100) });
      messages.push({ role: 'assistant', content: 'b'.repeat(100) });
    }

    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.summary).toContain('Goal');
    expect(result!.afterCount).toBeLessThan(result!.beforeCount);
    expect(llm.callLog).toHaveLength(1);
  });

  it('stage 1 truncation alone is enough when content is huge but few messages', async () => {
    const llm = new MockLLMProvider([]);
    const compactor = new TwoStageCompactor({
      llm,
      contextWindow: 200,
      reserveTokens: 50,
      toolResultTruncateChars: 100,
    });

    const messages: ChatMessage[] = [
      { role: 'user', content: 'x'.repeat(2000) },
    ];

    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    // LLM이 호출되지 않음 (stage 1만으로 충분)
    expect(llm.callLog).toHaveLength(0);
    expect(result!.newMessages[0].content).toContain('truncated');
  });
});
