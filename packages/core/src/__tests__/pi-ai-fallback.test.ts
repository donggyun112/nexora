import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FallbackLLMProvider } from '../llm/fallback.js';
import { PiAiProvider } from '../llm/pi-ai/provider.js';

vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>();
  return {
    ...actual,
    stream: vi.fn(),
    complete: vi.fn(),
    getModel: vi.fn(() => ({
      id: 'mock', name: 'mock',
      api: 'openai-completions' as const,
      provider: 'openai' as const,
      reasoning: false, input: ['text'] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000, maxTokens: 1000,
    })),
  };
});

import * as piAi from '@earendil-works/pi-ai';

const asstMsg = (text: string): piAi.AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason: 'stop',
  api: 'openai-completions',
  provider: 'openai',
  model: 'mock',
  usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
  timestamp: 0,
} as never);

describe('FallbackLLMProvider + PiAiProvider', () => {
  beforeEach(() => { vi.mocked(piAi.complete).mockReset(); });

  it('falls back to second pi-ai provider on first failure', async () => {
    vi.mocked(piAi.complete)
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockResolvedValueOnce(asstMsg('rescued'));

    const primary = new PiAiProvider({ provider: 'openai', model: 'gpt-4o' });
    const secondary = new PiAiProvider({ provider: 'openai', model: 'gpt-4o-mini' });

    const fallback = new FallbackLLMProvider({
      providers: [
        { name: 'primary', provider: primary },
        { name: 'secondary', provider: secondary },
      ],
      rateLimitRetryMs: 0,
    });

    const r = await fallback.complete([{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('rescued');
  });

  it('uses primary when it succeeds (no secondary call)', async () => {
    vi.mocked(piAi.complete).mockResolvedValueOnce(asstMsg('primary worked'));

    const primary = new PiAiProvider({ provider: 'openai', model: 'gpt-4o' });
    const secondary = new PiAiProvider({ provider: 'openai', model: 'gpt-4o-mini' });

    const fallback = new FallbackLLMProvider({
      providers: [
        { name: 'primary', provider: primary },
        { name: 'secondary', provider: secondary },
      ],
    });
    const r = await fallback.complete([{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('primary worked');
    expect(vi.mocked(piAi.complete)).toHaveBeenCalledTimes(1);
  });
});
