import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@dongkseo/contracts';
import {
  agentEventToPiWire,
  createPiMapState,
  drivePi,
  type PiWireEvent,
} from '../pi-headless.js';

/** Collect every wire event produced by mapping a full AgentEvent stream. */
function mapStream(events: AgentEvent[]): PiWireEvent[] {
  const state = createPiMapState();
  return events.flatMap((ev) => agentEventToPiWire(ev, state));
}

describe('agentEventToPiWire', () => {
  it('maps streamed text to text_delta message_update', () => {
    expect(mapStream([{ type: 'text', text: 'hello' }])).toEqual([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } },
    ]);
  });

  it('maps thinking to thinking_delta message_update', () => {
    expect(mapStream([{ type: 'thinking', content: 'pondering' }])).toEqual([
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' } },
    ]);
  });

  it('drops empty text/thinking deltas', () => {
    expect(mapStream([{ type: 'text', text: '' }, { type: 'thinking', content: '' }])).toEqual([]);
  });

  it('maps tool_call to tool_execution_start with toolCallId/toolName/args', () => {
    expect(
      mapStream([{ type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.md' } }]),
    ).toEqual([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read_file', args: { path: 'a.md' } },
    ]);
  });

  it('maps tool_result to tool_execution_end with result/isError', () => {
    expect(
      mapStream([{ type: 'tool_result', id: 'c1', name: 'read_file', result: 'body', isError: false }]),
    ).toEqual([{ type: 'tool_execution_end', toolCallId: 'c1', result: 'body', isError: false }]);
  });

  it('emits turn_end on done when text was streamed (no re-emit of content)', () => {
    expect(
      mapStream([
        { type: 'text', text: 'hi ' },
        { type: 'text', text: 'there' },
        { type: 'done', content: 'hi there', toolCalls: [] },
      ]),
    ).toEqual([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi ' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'there' } },
      { type: 'turn_end', message: { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } },
    ]);
  });

  it('surfaces done.content as one text_delta when nothing was streamed', () => {
    expect(mapStream([{ type: 'done', content: 'final only', toolCalls: [] }])).toEqual([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'final only' } },
      { type: 'turn_end', message: { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } },
    ]);
  });

  it('maps error to a pi error event', () => {
    expect(mapStream([{ type: 'error', message: 'boom' }])).toEqual([{ type: 'error', message: 'boom' }]);
  });

  it('maps suspended (HITL) to an error — pi protocol is autonomous', () => {
    const out = mapStream([{ type: 'suspended', pendingId: 'p1', toolCallId: 'c9' }]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('error');
  });

  it('drops progress and artifact events', () => {
    const events: AgentEvent[] = [
      { type: 'progress', message: 'working' },
      { type: 'artifact', artifact: { kind: 'x' } as never },
    ];
    expect(mapStream(events)).toEqual([]);
  });

  it('maps done.usage to turn_end usage (real tokens)', () => {
    const out = mapStream([
      { type: 'done', content: 'hi', toolCalls: [], usage: { promptTokens: 1234, completionTokens: 567, cachedTokens: 89 } },
    ]);
    const turnEnd = out.find((e) => e.type === 'turn_end');
    expect(turnEnd).toMatchObject({
      type: 'turn_end',
      message: { usage: { input: 1234, output: 567, cacheRead: 89, cacheWrite: 0, totalTokens: 1801 } },
    });
  });

  it('falls back to zero usage when done carries none', () => {
    const out = mapStream([{ type: 'done', content: 'x', toolCalls: [] }]);
    const turnEnd = out.find((e) => e.type === 'turn_end') as { message: { usage: { totalTokens: number } } };
    expect(turnEnd.message.usage.totalTokens).toBe(0);
  });

  it('carries done.model onto turn_end.message (lets Multica price the run)', () => {
    const out = mapStream([
      { type: 'done', content: 'hi', toolCalls: [], model: 'gpt-5.5' },
    ]);
    const turnEnd = out.find((e) => e.type === 'turn_end') as { message: { model?: string } };
    expect(turnEnd.message.model).toBe('gpt-5.5');
  });

  it('omits model from turn_end.message when done carries none', () => {
    const out = mapStream([{ type: 'done', content: 'x', toolCalls: [] }]);
    const turnEnd = out.find((e) => e.type === 'turn_end') as { message: Record<string, unknown> };
    expect('model' in turnEnd.message).toBe(false);
  });
});

describe('drivePi', () => {
  async function* gen(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
    for (const e of events) yield e;
  }

  it('always emits agent_start first, then mapped events, then turn_end', async () => {
    const lines: string[] = [];
    const result = await drivePi({
      run: () => gen([
        { type: 'text', text: 'ok' },
        { type: 'done', content: 'ok', toolCalls: [] },
      ]),
      write: (l) => lines.push(l),
    });

    expect(result).toEqual({ status: 'completed' });
    expect(lines.map((l) => JSON.parse(l).type)).toEqual([
      'agent_start',
      'message_update',
      'turn_end',
    ]);
  });

  it('mirrors every line to the session sink', async () => {
    const stdout: string[] = [];
    const session: string[] = [];
    await drivePi({
      run: () => gen([{ type: 'done', content: 'x', toolCalls: [] }]),
      write: (l) => stdout.push(l),
      appendSession: (l) => session.push(l),
    });
    expect(session).toEqual(stdout);
  });

  it('reports failed when the stream yields an error event', async () => {
    const lines: string[] = [];
    const result = await drivePi({
      run: () => gen([{ type: 'error', message: 'nope' }]),
      write: (l) => lines.push(l),
    });
    expect(result).toEqual({ status: 'failed', error: 'nope' });
  });

  it('catches a thrown generator error and reports failed', async () => {
    // eslint-disable-next-line require-yield
    async function* boom(): AsyncGenerator<AgentEvent> {
      throw new Error('kaboom');
    }
    const lines: string[] = [];
    const result = await drivePi({ run: () => boom(), write: (l) => lines.push(l) });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('kaboom');
    expect(JSON.parse(lines[lines.length - 1])).toEqual({ type: 'error', message: 'kaboom' });
  });

  it('synthesizes a terminal turn_end when the stream ends without done/error', async () => {
    const lines: string[] = [];
    await drivePi({
      run: () => gen([{ type: 'text', text: 'partial' }]),
      write: (l) => lines.push(l),
    });
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['agent_start', 'message_update', 'turn_end']);
  });
});
