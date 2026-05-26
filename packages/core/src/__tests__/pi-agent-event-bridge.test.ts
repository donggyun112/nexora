import { describe, it, expect } from 'vitest';
import { fromPiEvent } from '../pi-agent/event-bridge.js';
import type { AgentEvent as PiEvent } from '@earendil-works/pi-agent-core';

const collect = (e: PiEvent) => [...fromPiEvent(e)];

describe('fromPiEvent', () => {
  it('maps tool_execution_start to tool_call', () => {
    expect(collect({
      type: 'tool_execution_start',
      toolCallId: 't1', toolName: 'search', args: { q: 'x' },
    } as PiEvent)).toEqual([
      { type: 'tool_call', id: 't1', name: 'search', input: { q: 'x' } },
    ]);
  });

  it('maps tool_execution_end to tool_result', () => {
    expect(collect({
      type: 'tool_execution_end',
      toolCallId: 't1', toolName: 'search',
      result: { content: [{ type: 'text', text: 'OK' }], details: undefined },
      isError: false,
    } as PiEvent)).toEqual([
      { type: 'tool_result', id: 't1', name: 'search',
        result: { content: [{ type: 'text', text: 'OK' }], details: undefined },
        isError: false },
    ]);
  });

  it('emits artifact event when tool_execution_end details contains artifact', () => {
    const out = collect({
      type: 'tool_execution_end',
      toolCallId: 't1', toolName: 'render',
      result: {
        content: [{ type: 'text', text: 'chart' }],
        details: { artifact: { kind: 'image', uri: 'attachment://chart.png' } },
      },
      isError: false,
    } as PiEvent);
    expect(out).toContainEqual(expect.objectContaining({ type: 'tool_result' }));
    expect(out).toContainEqual({
      type: 'artifact',
      artifact: { kind: 'image', uri: 'attachment://chart.png' },
    });
  });

  it('maps agent_end to done with content joined from last assistant message', () => {
    const out = collect({
      type: 'agent_end',
      messages: [
        { role: 'user', content: 'q', timestamp: 0 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'reply' }],
          stopReason: 'stop',
          api: 'openai-completions', provider: 'openai', model: 'm',
          usage: { input: 0, output: 0, cost: { input: 0, output: 0, total: 0 } },
          timestamp: 0,
        },
      ],
    } as PiEvent);
    const done = out.find(e => e.type === 'done');
    expect(done).toMatchObject({ type: 'done', content: 'reply' });
  });

  it('agent_end with no assistant message yields done with empty content', () => {
    const out = collect({
      type: 'agent_end',
      messages: [{ role: 'user', content: 'q', timestamp: 0 }],
    } as PiEvent);
    const done = out.find(e => e.type === 'done');
    expect(done).toMatchObject({ type: 'done', content: '' });
  });

  it('emits text from message_update with inner text_delta', () => {
    expect(collect({
      type: 'message_update',
      message: {} as never,
      assistantMessageEvent: {
        type: 'text_delta', delta: 'hi', contentIndex: 0, partial: {} as never,
      },
    } as PiEvent)).toEqual([
      { type: 'text', text: 'hi' },
    ]);
  });

  it('emits thinking from message_update with inner thinking_delta', () => {
    expect(collect({
      type: 'message_update',
      message: {} as never,
      assistantMessageEvent: {
        type: 'thinking_delta', delta: '...', contentIndex: 0, partial: {} as never,
      },
    } as PiEvent)).toEqual([
      { type: 'thinking', content: '...' },
    ]);
  });

  it('emits nothing for message_update with non-mapped inner events', () => {
    expect(collect({
      type: 'message_update',
      message: {} as never,
      assistantMessageEvent: {
        type: 'text_start', contentIndex: 0, partial: {} as never,
      },
    } as PiEvent)).toEqual([]);
  });

  it('returns nothing for non-mapped events', () => {
    expect(collect({ type: 'agent_start' } as PiEvent)).toEqual([]);
    expect(collect({ type: 'turn_start' } as PiEvent)).toEqual([]);
    expect(collect({ type: 'message_start', message: {} as never } as PiEvent)).toEqual([]);
    expect(collect({ type: 'message_end', message: {} as never } as PiEvent)).toEqual([]);
  });
});
