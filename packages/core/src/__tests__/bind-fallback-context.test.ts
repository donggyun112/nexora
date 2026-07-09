import { describe, it, expect } from 'vitest';
import { FallbackLLMProvider } from '../llm/fallback.js';
import { fallbackAls, bindFallbackContext, type FallbackRecord } from '../llm/fallback-als.js';
import { MockLLMProvider } from './mock-llm.js';

function sinkCollector() {
  const records: FallbackRecord[] = [];
  return { sink: { record: (r: FallbackRecord) => records.push(r) }, records };
}

describe('bindFallbackContext', () => {
  it('propagates ALS through complete() so a fallback records', async () => {
    const primary = new MockLLMProvider([{ text: '', throwError: 'rate limit exceeded' }]);
    const secondary = new MockLLMProvider([{ text: 'ok' }]);
    const fb = new FallbackLLMProvider({
      providers: [{ name: 'primary', provider: primary }, { name: 'secondary', provider: secondary }],
      rateLimitRetryMs: 0,
    });
    const { sink, records } = sinkCollector();
    const bound = bindFallbackContext(fb, sink);
    const res = await bound.complete([{ role: 'user', content: 'hi' }]);
    expect(res.content).toBe('ok');
    expect(records).toEqual([{ from: 'primary', to: 'secondary', errorClass: 'rate-limit' }]);
  });

  it('propagates ALS through stream() (per-next) so a streaming fallback records', async () => {
    const primary = new MockLLMProvider([{ text: '', throwError: 'rate limit exceeded' }]);
    const secondary = new MockLLMProvider([{ text: 'streamed' }]);
    const fb = new FallbackLLMProvider({
      providers: [{ name: 'primary', provider: primary }, { name: 'secondary', provider: secondary }],
      rateLimitRetryMs: 0,
    });
    const { sink, records } = sinkCollector();
    const bound = bindFallbackContext(fb, sink);
    let out = '';
    for await (const chunk of bound.stream([{ role: 'user', content: 'hi' }])) out += chunk.content ?? '';
    expect(out).toContain('streamed');
    expect(records).toEqual([{ from: 'primary', to: 'secondary', errorClass: 'rate-limit' }]);
  });

  it('returns the llm unchanged when sink is undefined', () => {
    const fb = new FallbackLLMProvider({ providers: [{ name: 'p', provider: new MockLLMProvider([{ text: 'x' }]) }] });
    expect(bindFallbackContext(fb, undefined)).toBe(fb);
  });
});
