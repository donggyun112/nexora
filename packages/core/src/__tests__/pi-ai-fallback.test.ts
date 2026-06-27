import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { FallbackLLMProvider } from '../llm/fallback.js';
import { PiAiProvider } from '../llm/pi-ai/provider.js';

// Mock the builtinModels() factory PiAiProvider uses; the fake's completeSimple
// spy stands in for real pi-ai calls. See pi-ai-provider.test.ts for the rationale.
const { piAi } = vi.hoisted(() => ({
  piAi: {
    streamSimple: vi.fn(),
    completeSimple: vi.fn(),
    getModel: vi.fn(() => ({
      id: 'mock', name: 'mock',
      api: 'openai-completions' as const,
      provider: 'openai' as const,
      reasoning: false, input: ['text'] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000, maxTokens: 1000,
    })),
  },
}));

vi.mock('@earendil-works/pi-ai/providers/all', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai/providers/all')>();
  return { ...actual, builtinModels: () => piAi };
});

const asstMsg = (text: string): AssistantMessage => ({
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
  beforeEach(() => { vi.mocked(piAi.completeSimple).mockReset(); });

  it('falls back to second pi-ai provider on first failure', async () => {
    vi.mocked(piAi.completeSimple)
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
    vi.mocked(piAi.completeSimple).mockResolvedValueOnce(asstMsg('primary worked'));

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
    expect(vi.mocked(piAi.completeSimple)).toHaveBeenCalledTimes(1);
  });
});
