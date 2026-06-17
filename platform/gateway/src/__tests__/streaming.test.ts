/**
 * StreamingGatewayRouter — proves true token-level SSE streaming.
 */

import { describe, it, expect } from 'vitest';
import { StreamingGatewayRouter } from '../streaming-router.js';
import type {
  MessageRouter,
  InboundMessage,
  OutboundMessage,
  OutboundChunk,
  AgentRuntime,
  AgentInput,
  AgentEvent,
} from '@dongkseo/contracts';

function makeRuntime(events: AgentEvent[]): AgentRuntime {
  return {
    async *execute(_input: AgentInput) {
      for (const e of events) yield e;
    },
    abort: () => {},
  };
}

const fakeInner: MessageRouter = {
  async route(): Promise<OutboundMessage> {
    return { content: 'inner-route-result' };
  },
  async routeStream(_msg, onChunk): Promise<void> {
    onChunk({ type: 'text', text: 'inner-stream' });
    onChunk({ type: 'done', content: 'inner-stream' });
  },
};

function makeInbound(content = 'test'): InboundMessage {
  return {
    platform: 'test',
    channelId: 'ch',
    userId: 'u',
    displayName: 'user',
    content,
    tenantId: 'default',
  };
}

describe('StreamingGatewayRouter', () => {
  it('route() delegates to inner router (transport-based)', async () => {
    const router = new StreamingGatewayRouter({
      inner: fakeInner,
      createRuntime: () => makeRuntime([]),
    });

    const result = await router.route(makeInbound());
    expect(result.content).toBe('inner-route-result');
  });

  it('routeStream() uses AgentRuntime directly for true streaming', async () => {
    const router = new StreamingGatewayRouter({
      inner: fakeInner,
      createRuntime: () => makeRuntime([
        { type: 'text', text: 'chunk1' },
        { type: 'tool_call', id: 't1', name: 'read', input: {} },
        { type: 'tool_result', id: 't1', name: 'read', result: { type: 'text', text: 'ok' }, isError: false },
        { type: 'text', text: 'chunk2' },
        { type: 'done', content: 'chunk1chunk2', toolCalls: [] },
      ]),
    });

    const chunks: OutboundChunk[] = [];
    await router.routeStream(makeInbound(), (c) => chunks.push(c));

    const types = chunks.map(c => c.type);
    expect(types).toEqual(['text', 'tool_call', 'tool_result', 'text', 'done']);
    expect((chunks[0] as { text: string }).text).toBe('chunk1');
    expect((chunks[3] as { text: string }).text).toBe('chunk2');
  });

  it('routeStream() forwards error events', async () => {
    const router = new StreamingGatewayRouter({
      inner: fakeInner,
      createRuntime: () => makeRuntime([
        { type: 'error', message: 'llm failed' },
      ]),
    });

    const chunks: OutboundChunk[] = [];
    await router.routeStream(makeInbound(), (c) => chunks.push(c));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('error');
    if (chunks[0].type === 'error') expect(chunks[0].message).toBe('llm failed');
  });

  it('routeStream() handles empty event stream', async () => {
    const router = new StreamingGatewayRouter({
      inner: fakeInner,
      createRuntime: () => makeRuntime([]),
    });

    const chunks: OutboundChunk[] = [];
    await router.routeStream(makeInbound(), (c) => chunks.push(c));
    expect(chunks).toHaveLength(0);
  });
});
