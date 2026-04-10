import { describe, it, expect, vi } from 'vitest';
import { FallbackLLMProvider } from '../llm/fallback.js';
import { MockLLMProvider } from './mock-llm.js';

describe('FallbackLLMProvider', () => {
  it('uses primary when it succeeds', async () => {
    const primary = new MockLLMProvider([{ text: 'primary works' }]);
    const secondary = new MockLLMProvider([{ text: 'secondary' }]);

    const fallback = new FallbackLLMProvider({
      providers: [
        { name: 'primary', provider: primary },
        { name: 'secondary', provider: secondary },
      ],
    });

    const result = await fallback.complete([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('primary works');
    expect(secondary.callLog).toHaveLength(0);
  });

  it('falls back to secondary on primary error', async () => {
    const primary = new MockLLMProvider([{ text: '', throwError: 'auth failed' }]);
    const secondary = new MockLLMProvider([{ text: 'secondary saved the day' }]);
    const onFallback = vi.fn();

    const fallback = new FallbackLLMProvider({
      providers: [
        { name: 'primary', provider: primary },
        { name: 'secondary', provider: secondary },
      ],
      onFallback,
    });

    const result = await fallback.complete([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('secondary saved the day');
    expect(onFallback).toHaveBeenCalledWith('primary', 'secondary', 'auth failed');
  });

  it('throws when all providers fail', async () => {
    const primary = new MockLLMProvider([{ text: '', throwError: 'fail 1' }]);
    const secondary = new MockLLMProvider([{ text: '', throwError: 'fail 2' }]);

    const fallback = new FallbackLLMProvider({
      providers: [
        { name: 'primary', provider: primary },
        { name: 'secondary', provider: secondary },
      ],
    });

    await expect(fallback.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('fail 2');
  });

  it('falls back on empty response', async () => {
    const primary = new MockLLMProvider([{ text: '' }]);
    const secondary = new MockLLMProvider([{ text: 'real response' }]);
    const onFallback = vi.fn();

    const fallback = new FallbackLLMProvider({
      providers: [
        { name: 'primary', provider: primary },
        { name: 'secondary', provider: secondary },
      ],
      onFallback,
    });

    const result = await fallback.complete([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('real response');
    expect(onFallback).toHaveBeenCalledWith('primary', 'secondary', 'empty response');
  });

  // Codex re-review fix #4b: AbortError must NOT trigger fallback.
  // Previously, a user abort would cause the fallback to pointlessly try the
  // next provider (which would also have to fail before the caller learned
  // about the cancellation).
  it('does NOT fall back on AbortError', async () => {
    const primary = {
      stream: async function* () { /* unused */ },
      complete: async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    } as unknown as ConstructorParameters<typeof FallbackLLMProvider>[0]['providers'][0]['provider'];

    const secondary = new MockLLMProvider([{ text: 'should never be called' }]);
    const onFallback = vi.fn();

    const fallback = new FallbackLLMProvider({
      providers: [
        { name: 'primary', provider: primary },
        { name: 'secondary', provider: secondary },
      ],
      onFallback,
    });

    await expect(
      fallback.complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/aborted/);
    expect(onFallback).not.toHaveBeenCalled();
    expect(secondary.callLog).toHaveLength(0);
  });

  // Codex round-3 fix #4b: pre-aborted signal must NOT invoke ANY provider.
  it('pre-aborted signal: does not call primary at all', async () => {
    let primaryCalled = false;
    const primary = {
      stream: async function* () { primaryCalled = true; },
      complete: async () => { primaryCalled = true; return { content: 'x', model: 'm', stopReason: 'end_turn' }; },
    } as unknown as ConstructorParameters<typeof FallbackLLMProvider>[0]['providers'][0]['provider'];
    const secondary = new MockLLMProvider([{ text: 'should never be called' }]);

    const fallback = new FallbackLLMProvider({
      providers: [
        { name: 'primary', provider: primary },
        { name: 'secondary', provider: secondary },
      ],
    });

    const ac = new AbortController();
    ac.abort();

    await expect(
      fallback.complete([{ role: 'user', content: 'hi' }], { signal: ac.signal }),
    ).rejects.toThrow(/abort/i);
    // The critical assertion — primary must NOT have been called at all.
    expect(primaryCalled).toBe(false);
    expect(secondary.callLog).toHaveLength(0);
  });

  // Codex round-3 fix #4b: aborted empty-response must throw, not return success.
  it('aborted empty response throws instead of returning silent empty', async () => {
    // Primary returns empty content, but signal gets aborted mid-call.
    const ac = new AbortController();
    const primary = {
      stream: async function* () {},
      complete: async () => {
        ac.abort(); // abort happens during the call
        return { content: '', model: 'm', stopReason: 'end_turn' };
      },
    } as unknown as ConstructorParameters<typeof FallbackLLMProvider>[0]['providers'][0]['provider'];
    const secondary = new MockLLMProvider([{ text: 'should not be called' }]);

    const fallback = new FallbackLLMProvider({
      providers: [
        { name: 'primary', provider: primary },
        { name: 'secondary', provider: secondary },
      ],
    });

    await expect(
      fallback.complete([{ role: 'user', content: 'hi' }], { signal: ac.signal }),
    ).rejects.toThrow(/abort/i);
    expect(secondary.callLog).toHaveLength(0);
  });
});
