import { describe, it, expect, vi } from 'vitest';
import { toAgentTools } from '../pi-agent/tool-bridge.js';
import type { ToolDefinition, ToolExecutor } from '@nexora/contracts';

const sampleTools: ToolDefinition[] = [
  {
    name: 'search',
    description: 'web search',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    },
    execute: async () => ({ type: 'text', text: 'unused' }),
  } as unknown as ToolDefinition,
];

function fakeExecutor(impl: (name: string, callId: string, input: unknown) => unknown): ToolExecutor {
  return {
    execute: vi.fn(async (name, callId, input) => impl(name, callId, input)),
    list: () => sampleTools.map(t => ({
      name: t.name, description: t.description, parameters: t.parameters,
    })),
    get: (name) => sampleTools.find(t => t.name === name),
  };
}

describe('toAgentTools', () => {
  it('preserves name/description and provides label', () => {
    const exec = fakeExecutor(() => 'ok');
    const out = toAgentTools(sampleTools, exec);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('search');
    expect(out[0].description).toBe('web search');
    expect(out[0].label).toBe('search');
  });

  it('passes the original JSON Schema parameters through as TypeBox-compatible schema', () => {
    const exec = fakeExecutor(() => 'ok');
    const out = toAgentTools(sampleTools, exec);
    expect(out[0].parameters).toMatchObject({ type: 'object' });
  });

  it('execute() forwards toolCallId, args, and signal to the executor', async () => {
    const exec = fakeExecutor(() => 'world');
    const out = toAgentTools(sampleTools, exec);
    const ac = new AbortController();
    const r = await out[0].execute('call_1', { q: 'hi' } as never, ac.signal);
    expect(r.content).toEqual([{ type: 'text', text: 'world' }]);
    expect(exec.execute).toHaveBeenCalledWith('search', 'call_1', { q: 'hi' }, ac.signal);
  });

  it('wraps string results as a single TextContent block', async () => {
    const exec = fakeExecutor(() => 'hello');
    const out = toAgentTools(sampleTools, exec);
    const r = await out[0].execute('c', { q: 'x' } as never);
    expect(r.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('passes through structured { content, details } results untouched', async () => {
    const exec = fakeExecutor(() => ({
      content: [
        { type: 'text', text: 'caption' },
        { type: 'image', data: 'B64', mimeType: 'image/png' },
      ],
      details: { foo: 'bar' },
    }));
    const out = toAgentTools(sampleTools, exec);
    const r = await out[0].execute('c', { q: 'x' } as never);
    expect(r.content).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'B64', mimeType: 'image/png' },
    ]);
    expect(r.details).toEqual({ foo: 'bar' });
  });

  it('surfaces artifact in result.details when present', async () => {
    const exec = fakeExecutor(() => ({
      content: [{ type: 'text', text: 'rendered' }],
      details: { artifact: { kind: 'image', uri: 'attachment://chart.png' } },
    }));
    const out = toAgentTools(sampleTools, exec);
    const r = await out[0].execute('c', { q: 'x' } as never);
    expect(r.details).toEqual({ artifact: { kind: 'image', uri: 'attachment://chart.png' } });
  });

  it('JSON-stringifies other non-string return values into a text block', async () => {
    const exec = fakeExecutor(() => ({ random: 'plain object' }));
    const out = toAgentTools(sampleTools, exec);
    const r = await out[0].execute('c', { q: 'x' } as never);
    expect(r.content).toEqual([
      { type: 'text', text: JSON.stringify({ random: 'plain object' }) },
    ]);
    expect(r.details).toEqual({ random: 'plain object' });
  });
});
