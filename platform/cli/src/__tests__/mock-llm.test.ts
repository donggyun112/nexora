import { describe, it, expect } from 'vitest';
import { SmartMockLLM } from '../mock-llm.js';

describe('SmartMockLLM (test-serve deterministic mock)', () => {
  const llm = new SmartMockLLM();

  it('triggers the read tool on "read the file"', async () => {
    const r = await llm.complete([{ role: 'user', content: 'please read the file' }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls?.[0]?.name).toBe('read');
  });

  it('triggers grep on "search for"', async () => {
    const r = await llm.complete([{ role: 'user', content: 'search for foo' }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls?.[0]?.name).toBe('grep');
  });

  it('echoes by default and ends the turn', async () => {
    const r = await llm.complete([{ role: 'user', content: 'some random message' }]);
    expect(r.stopReason).toBe('end_turn');
    expect(r.content).toContain('some random message');
    expect(r.toolCalls).toBeUndefined();
  });

  it('finalizes (no tool) after a tool_result — never loops', async () => {
    const r = await llm.complete([
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: '' },
      { role: 'tool_result', content: '{"name":"pkg"}' },
    ]);
    expect(r.stopReason).toBe('end_turn');
    expect(r.toolCalls).toBeUndefined();
  });

  it('answers the evaluate phase with respond:true', async () => {
    const r = await llm.complete(
      [{ role: 'user', content: 'hi' }],
      { systemPrompt: 'Output ONLY a JSON object with "respond": bool ...' },
    );
    expect(JSON.parse(r.content).respond).toBe(true);
  });

  it('stream yields a terminal done chunk', async () => {
    const chunks: { type: string }[] = [];
    for await (const c of llm.stream([{ role: 'user', content: 'hi' }])) chunks.push(c as { type: string });
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
  });

  it('stream emits tool_call_start + tool_call_delta for a tool trigger (streamLlm shape)', async () => {
    const chunks: { type: string; id?: string; name?: string; delta?: string }[] = [];
    for await (const c of llm.stream([{ role: 'user', content: 'read the file' }])) {
      chunks.push(c as { type: string });
    }
    const start = chunks.find((c) => c.type === 'tool_call_start');
    const delta = chunks.find((c) => c.type === 'tool_call_delta');
    expect(start?.name).toBe('read');
    expect(JSON.parse(delta!.delta!)).toEqual({ path: 'package.json' });
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
  });
});
