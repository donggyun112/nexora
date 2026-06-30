import { describe, expect, it } from 'vitest';
import type { LLMChunk, LLMMessage, LLMOptions, LLMProvider, LLMResponse } from '@dongkseo/contracts';
import { FallbackLLMProvider } from '@dongkseo/core';

import {
  buildHeadlessProviderSpecs,
  FixedHeadlessModelProvider,
  headlessProviderName,
} from '../headless.js';

function apiError(status: number): Error & { status: number } {
  const err = new Error(`status ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

class CapturingProvider implements LLMProvider {
  readonly calls: Array<{ messages: LLMMessage[]; options?: LLMOptions }> = [];

  constructor(private readonly behavior: 'rate-limit' | 'ok') {}

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    this.calls.push({ messages, options });
    if (this.behavior === 'rate-limit') throw apiError(429);
    yield { type: 'done', content: 'ok', stopReason: 'end_turn' };
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    this.calls.push({ messages, options });
    if (this.behavior === 'rate-limit') throw apiError(429);
    return { content: 'ok', model: options?.model ?? 'missing', stopReason: 'end_turn' };
  }
}

describe('headless LLM fallback provider specs', () => {
  it('keeps cross-provider candidates before same-provider candidates for 429 fallback', () => {
    const specs = buildHeadlessProviderSpecs(
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      [
        'anthropic/claude-sonnet-4-5',
        'anthropic/claude-haiku-4-5',
        'openai/gpt-4o',
        'openrouter/openai/gpt-5',
      ],
    );

    expect(specs).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'openrouter', model: 'openai/gpt-5' },
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
    ]);
  });

  it('dedupes the primary and ignores invalid model ids', () => {
    const specs = buildHeadlessProviderSpecs(
      { provider: 'openai', model: 'gpt-4o' },
      ['openai/gpt-4o', 'not-qualified', '/missing-provider', 'missing-model/'],
    );

    expect(specs).toEqual([{ provider: 'openai', model: 'gpt-4o' }]);
  });

  it('uses provider/model names even when the model id contains slashes', () => {
    expect(headlessProviderName({ provider: 'openrouter', model: 'openai/gpt-5' })).toBe(
      'openrouter/openai/gpt-5',
    );
  });

  it('forces the fallback provider model instead of leaking the primary options.model', async () => {
    const primary = new CapturingProvider('rate-limit');
    const fallback = new CapturingProvider('ok');
    const llm = new FallbackLLMProvider({
      providers: [
        {
          name: 'anthropic/claude-sonnet-4-5',
          provider: new FixedHeadlessModelProvider(primary, 'claude-sonnet-4-5') as unknown as LLMProvider,
        },
        {
          name: 'openai/gpt-4o',
          provider: new FixedHeadlessModelProvider(fallback, 'gpt-4o') as unknown as LLMProvider,
        },
      ],
      rateLimitRetryMs: 0,
    });

    const chunks: LLMChunk[] = [];
    for await (const chunk of llm.stream([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-5' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ type: 'done', content: 'ok', stopReason: 'end_turn' }]);
    expect(primary.calls[0].options?.model).toBe('claude-sonnet-4-5');
    expect(fallback.calls[0].options?.model).toBe('gpt-4o');
  });
});
