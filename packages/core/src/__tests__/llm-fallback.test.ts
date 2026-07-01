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
    expect(onFallback).toHaveBeenCalledWith('primary', 'secondary', '[unknown] auth failed');
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

  // AbortError must NOT trigger fallback. A user abort should not cause the
  // fallback to pointlessly try the next provider.
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

  // Pre-aborted signal must NOT invoke ANY provider.
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

  // Aborted empty-response must throw, not return success.
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

  // A single transient connection blip ('terminated') must NOT kill the run.
  // With a sole provider there is nothing to fall back to, so the same provider
  // is retried and the recovered response is returned.
  it('retries same provider on transient error then succeeds (single provider)', async () => {
    const primary = new MockLLMProvider([
      { text: '', throwError: 'terminated' },
      { text: 'recovered' },
    ]);
    const onFallback = vi.fn();

    const fallback = new FallbackLLMProvider({
      providers: [{ name: 'primary', provider: primary }],
      onFallback,
      transientRetryMs: 1, // keep the test fast
    });

    const result = await fallback.complete([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('recovered');
    expect(primary.callLog).toHaveLength(2); // first throw + retry
    expect(onFallback).not.toHaveBeenCalled();
  });

  // A sustained transient error must eventually throw after the bounded number
  // of same-provider retries (no infinite loop).
  it('throws after exhausting bounded transient retries (single provider)', async () => {
    const primary = new MockLLMProvider([
      { text: '', throwError: 'terminated' },
      { text: '', throwError: 'terminated' },
      { text: '', throwError: 'terminated' },
    ]);

    const fallback = new FallbackLLMProvider({
      providers: [{ name: 'primary', provider: primary }],
      transientRetryMs: 1,
      transientRetryMaxAttempts: 2,
    });

    await expect(
      fallback.complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/terminated/);
    expect(primary.callLog).toHaveLength(3); // initial + 2 bounded retries
  });

  // stream(): a transient 'terminated' BEFORE any chunk reaches the caller is safe
  // to retry on the same provider. With a sole provider there is nothing to fall
  // back to, so the recovered content is streamed from the SAME provider.
  it('stream retries same provider on transient error before first chunk (single provider)', async () => {
    const primary = new MockLLMProvider([
      { text: '', throwError: 'terminated' },
      { text: 'recovered' },
    ]);
    const onFallback = vi.fn();

    const fallback = new FallbackLLMProvider({
      providers: [{ name: 'primary', provider: primary }],
      onFallback,
      transientRetryMs: 1, // keep the test fast
    });

    const chunks: string[] = [];
    for await (const chunk of fallback.stream([{ role: 'user', content: 'hi' }])) {
      if (chunk.type === 'text_delta') chunks.push(chunk.delta);
    }
    expect(chunks.join('')).toBe('recovered');
    expect(primary.callLog).toHaveLength(2); // first throw + retry
    expect(onFallback).not.toHaveBeenCalled();
  });

  // stream(): once a chunk has ALREADY reached the caller, a transient error must
  // NOT trigger a same-provider retry — that would re-yield the first chunk and
  // corrupt the stream. The error surfaces instead, and no chunk is duplicated.
  it('stream does NOT retry after a chunk was already yielded (mid-stream transient)', async () => {
    let calls = 0;
    const primary = {
      complete: async () => ({ content: 'x', model: 'm', stopReason: 'end_turn' as const }),
      stream: async function* () {
        calls++;
        yield { type: 'text_delta' as const, delta: 'partial' };
        throw new Error('terminated');
      },
    } as unknown as ConstructorParameters<typeof FallbackLLMProvider>[0]['providers'][0]['provider'];

    const fallback = new FallbackLLMProvider({
      providers: [{ name: 'primary', provider: primary }],
      transientRetryMs: 1,
    });

    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of fallback.stream([{ role: 'user', content: 'hi' }])) {
          if (chunk.type === 'text_delta') chunks.push(chunk.delta);
        }
      })(),
    ).rejects.toThrow(/terminated/);
    expect(chunks).toEqual(['partial']); // first chunk delivered exactly once, no duplicate
    expect(calls).toBe(1); // provider not re-invoked
  });

  // stream(): a sustained pre-chunk transient error must eventually throw after the
  // bounded number of same-provider retries (no infinite loop).
  it('stream throws after exhausting bounded transient retries (single provider)', async () => {
    const primary = new MockLLMProvider([
      { text: '', throwError: 'terminated' },
      { text: '', throwError: 'terminated' },
      { text: '', throwError: 'terminated' },
    ]);

    const fallback = new FallbackLLMProvider({
      providers: [{ name: 'primary', provider: primary }],
      transientRetryMs: 1,
      transientRetryMaxAttempts: 2,
    });

    await expect(
      (async () => {
        for await (const _chunk of fallback.stream([{ role: 'user', content: 'hi' }])) {
          // drain
        }
      })(),
    ).rejects.toThrow(/terminated/);
    expect(primary.callLog).toHaveLength(3); // initial + 2 bounded retries
  });

  it('pins each entry to its own model, overriding the caller-supplied model', async () => {
    const primary = new MockLLMProvider([{ text: '', throwError: 'boom' }]);
    const secondary = new MockLLMProvider([{ text: 'ok' }]);

    const fallback = new FallbackLLMProvider({
      providers: [
        { name: 'primary', provider: primary, model: 'primary-model' },
        { name: 'secondary', provider: secondary, model: 'secondary-model' },
      ],
    });

    const result = await fallback.complete(
      [{ role: 'user', content: 'hi' }],
      { model: 'caller-model' },
    );

    expect(result.content).toBe('ok');
    expect(primary.callLog[0].options?.model).toBe('primary-model');
    expect(secondary.callLog[0].options?.model).toBe('secondary-model');
  });

  it('passes caller options through unchanged when entry has no model', async () => {
    const primary = new MockLLMProvider([{ text: 'ok' }]);

    const fallback = new FallbackLLMProvider({
      providers: [{ name: 'primary', provider: primary }],
    });

    await fallback.complete([{ role: 'user', content: 'hi' }], { model: 'caller-model' });

    expect(primary.callLog[0].options?.model).toBe('caller-model');
  });

  it('pins the entry model in stream() too', async () => {
    const primary = new MockLLMProvider([{ text: 'streamed' }]);

    const fallback = new FallbackLLMProvider({
      providers: [{ name: 'primary', provider: primary, model: 'primary-model' }],
    });

    const chunks: string[] = [];
    for await (const c of fallback.stream(
      [{ role: 'user', content: 'hi' }],
      { model: 'caller-model' },
    )) {
      if (c.type === 'text_delta') chunks.push(c.delta);
    }

    expect(chunks.join('')).toBe('streamed');
    expect(primary.callLog[0].options?.model).toBe('primary-model');
  });
});
