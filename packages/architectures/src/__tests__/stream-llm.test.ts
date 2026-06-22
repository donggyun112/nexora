import { describe, it, expect } from 'vitest';
import type { AgentEvent, LLMChunk, LLMResponse } from '@dongkseo/contracts';
import { streamLlm } from '../stream-llm.js';

async function* fromChunks(chunks: LLMChunk[]): AsyncGenerator<LLMChunk> {
  for (const c of chunks) yield c;
}

/** Drive the generator, collecting yielded events and capturing the return value. */
async function drive(
  gen: AsyncGenerator<AgentEvent, LLMResponse>,
): Promise<{ events: AgentEvent[]; res: LLMResponse }> {
  const events: AgentEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, res: step.value };
    events.push(step.value);
  }
}

describe('streamLlm', () => {
  it('yields text deltas live and assembles content from done', async () => {
    const { events, res } = await drive(
      streamLlm(
        fromChunks([
          { type: 'text_delta', delta: 'Hel' },
          { type: 'text_delta', delta: 'lo' },
          { type: 'done', content: 'Hello', stopReason: 'end_turn' },
        ]),
        'gpt-test',
      ),
    );
    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ]);
    expect(res.content).toBe('Hello');
    expect(res.model).toBe('gpt-test');
    expect(res.stopReason).toBe('end_turn');
    expect(res.toolCalls).toBeUndefined();
  });

  it('reassembles tool calls from start+delta chunks', async () => {
    const { events, res } = await drive(
      streamLlm(
        fromChunks([
          { type: 'tool_call_start', id: 'c1', name: 'search' },
          { type: 'tool_call_delta', id: 'c1', delta: '{"q":' },
          { type: 'tool_call_delta', id: 'c1', delta: '"hi"}' },
          { type: 'done', content: '', stopReason: 'tool_use' },
        ]),
        'm',
      ),
    );
    expect(events).toEqual([]); // no text/thinking emitted
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'search', arguments: { q: 'hi' } }]);
    expect(res.stopReason).toBe('tool_use');
  });

  it('emits thinking deltas and carries usage through', async () => {
    const { events, res } = await drive(
      streamLlm(
        fromChunks([
          { type: 'thinking_delta', delta: 'reasoning' },
          { type: 'text_delta', delta: 'answer' },
          {
            type: 'done',
            content: 'answer',
            stopReason: 'end_turn',
            usage: { promptTokens: 12, completionTokens: 3, cachedTokens: 0, cacheWriteTokens: 0 },
          },
        ]),
        'm',
      ),
    );
    expect(events).toEqual([
      { type: 'thinking', content: 'reasoning' },
      { type: 'text', text: 'answer' },
    ]);
    expect(res.thinking).toBe('reasoning');
    expect(res.usage).toEqual({ promptTokens: 12, completionTokens: 3, cachedTokens: 0, cacheWriteTokens: 0 });
  });

  it('falls back to {} for malformed tool-call JSON', async () => {
    const { res } = await drive(
      streamLlm(
        fromChunks([
          { type: 'tool_call_start', id: 'c1', name: 'broken' },
          { type: 'tool_call_delta', id: 'c1', delta: '{not json' },
          { type: 'done', content: '', stopReason: 'tool_use' },
        ]),
        'm',
      ),
    );
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'broken', arguments: {} }]);
  });
});
