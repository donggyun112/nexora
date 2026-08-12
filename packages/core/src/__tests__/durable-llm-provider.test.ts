import { describe, expect, it } from 'vitest';
import type {
  LLMChunk,
  LLMMessage,
  LLMOptions,
  LLMProvider,
  LLMResponse,
} from '@dongkseo/contracts';
import { DurableLLMProvider } from '../durable-llm-provider.js';
import { IndeterminateEffectError } from '../durable-tool-executor.js';
import { MemoryEffectLedger } from '../memory-effect-ledger.js';

const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }];

async function collect(stream: AsyncGenerator<LLMChunk>): Promise<LLMChunk[]> {
  const chunks: LLMChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function provider(overrides: Partial<LLMProvider>): LLMProvider {
  return {
    async *stream(): AsyncGenerator<LLMChunk> {
      yield { type: 'done', content: 'ok', stopReason: 'end_turn' };
    },
    async complete(): Promise<LLMResponse> {
      return { content: 'ok', model: 'test', stopReason: 'end_turn' };
    },
    ...overrides,
  };
}

async function durable(inner: LLMProvider): Promise<DurableLLMProvider> {
  const ledger = new MemoryEffectLedger();
  const token = await ledger.acquire('run-1', 'worker-a', 60_000);
  return new DurableLLMProvider({
    inner,
    ledger,
    runId: 'run-1',
    fencingToken: token,
    modelIdentity: { provider: 'test', model: 'm1' },
  });
}

describe('DurableLLMProvider', () => {
  it('replays a committed stream without calling the provider again', async () => {
    let calls = 0;
    const llm = await durable(provider({
      async *stream(): AsyncGenerator<LLMChunk> {
        calls++;
        yield { type: 'text_delta', delta: 'hel' };
        yield { type: 'text_delta', delta: 'lo' };
        yield { type: 'done', content: 'hello', stopReason: 'end_turn' };
      },
    }));

    const first = await collect(llm.stream(messages, { model: 'm1' }));
    const replayed = await collect(llm.stream(messages, { model: 'm1' }));

    expect(replayed).toEqual(first);
    expect(calls).toBe(1);
  });

  it('does not include AbortSignal identity in the durable request key', async () => {
    let calls = 0;
    const llm = await durable(provider({
      async *stream(): AsyncGenerator<LLMChunk> {
        calls++;
        yield { type: 'done', content: 'ok', stopReason: 'end_turn' };
      },
    }));

    await collect(llm.stream(messages, { signal: new AbortController().signal }));
    await collect(llm.stream(messages, { signal: new AbortController().signal }));

    expect(calls).toBe(1);
  });

  it('clears intent when a stream fails before exposing a chunk', async () => {
    let calls = 0;
    const llm = await durable(provider({
      async *stream(): AsyncGenerator<LLMChunk> {
        calls++;
        if (calls === 1) throw new Error('connect failed');
        yield { type: 'done', content: 'recovered', stopReason: 'end_turn' };
      },
    }));

    await expect(collect(llm.stream(messages))).rejects.toThrow('connect failed');
    expect(await collect(llm.stream(messages))).toEqual([
      { type: 'done', content: 'recovered', stopReason: 'end_turn' },
    ]);
    expect(calls).toBe(2);
  });

  it('leaves partial streams indeterminate and never repeats them', async () => {
    let calls = 0;
    const llm = await durable(provider({
      async *stream(): AsyncGenerator<LLMChunk> {
        calls++;
        yield { type: 'text_delta', delta: 'visible' };
        throw new Error('connection dropped');
      },
    }));

    await expect(collect(llm.stream(messages))).rejects.toThrow('connection dropped');
    await expect(collect(llm.stream(messages))).rejects.toBeInstanceOf(
      IndeterminateEffectError,
    );
    expect(calls).toBe(1);
  });

  it('replays complete responses and returns defensive copies', async () => {
    let calls = 0;
    const llm = await durable(provider({
      async complete(_messages: LLMMessage[], _options?: LLMOptions): Promise<LLMResponse> {
        calls++;
        return { content: 'done', model: 'm1', stopReason: 'end_turn' };
      },
    }));

    const first = await llm.complete(messages);
    first.content = 'caller mutation';
    const replayed = await llm.complete(messages);

    expect(replayed.content).toBe('done');
    expect(calls).toBe(1);
  });

  it('does not alias distinct model-visible requests', async () => {
    let calls = 0;
    const llm = await durable(provider({
      async complete(input: LLMMessage[]): Promise<LLMResponse> {
        calls++;
        return { content: String(input.at(-1)?.content), model: 'm1', stopReason: 'end_turn' };
      },
    }));

    await llm.complete([{ role: 'user', content: 'one' }]);
    await llm.complete([{ role: 'user', content: 'two' }]);

    expect(calls).toBe(2);
  });
});
