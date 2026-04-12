/**
 * Personal Assistant E2E test — proves OpenClaw-style 1:1 assistant works.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConversationRoom, TurnManager } from '@nexora/conversation';
import { HttpAdapter } from '@nexora/adapters';
import { defineAgent, topic } from '@nexora/contracts';
import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMResponse,
  MessageRouter,
  InboundMessage,
  OutboundMessage,
  OutboundChunk,
} from '@nexora/contracts';

class MockAssistantLLM implements LLMProvider {
  async *stream(): AsyncGenerator<LLMChunk> {
    yield { type: 'done', content: 'mock', stopReason: 'end_turn' };
  }
  async complete(msgs: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    // TurnManager evaluate phase uses maxTokens ≤ 80. Return proper JSON.
    const isEvaluate = (opts?.maxTokens ?? 999) <= 80;
    if (isEvaluate) {
      return {
        content: JSON.stringify({ respond: true, confidence: 0.95, reason: 'I am the only agent' }),
        model: 'mock',
        stopReason: 'end_turn',
      };
    }

    const lastUser = [...msgs].reverse().find(m => m.role === 'user');
    const content = lastUser
      ? `You asked: "${typeof lastUser.content === 'string' ? lastUser.content.slice(0, 50) : '...'}" — here's my answer.`
      : 'Hello!';
    return { content, model: 'mock', stopReason: 'end_turn' };
  }
}

let adapter: HttpAdapter;
let port: number;
let room: ConversationRoom;

beforeAll(async () => {
  const card = defineAgent({
    name: 'test-assistant',
    description: 'Test personal assistant',
    architecture: 'conversation',
    tools: [],
    subscribes: [topic('assistant.requested')],
    publishes: [topic('assistant.completed')],
  });

  room = new ConversationRoom('test-session');
  room.join({ card, llm: new MockAssistantLLM() });

  const tm = new TurnManager({ maxResponders: 1 });

  const router: MessageRouter = {
    async route(msg: InboundMessage): Promise<OutboundMessage> {
      const rmsg = room.addUserMessage(msg.content, msg.displayName);
      const result = await tm.handleMessage(room, rmsg);
      return { content: result.responses[0]?.content ?? '(no response)' };
    },
    async routeStream(msg: InboundMessage, onChunk: (c: OutboundChunk) => void): Promise<void> {
      const out = await this.route(msg);
      onChunk({ type: 'text', text: out.content });
      onChunk({ type: 'done', content: out.content });
    },
  };

  adapter = new HttpAdapter({ port: 0, resolveTenant: () => 'default' });
  await adapter.start(router);
  port = adapter.port()!;
});

afterAll(async () => {
  await adapter.stop();
});

describe('Personal Assistant (OpenClaw-style)', () => {
  it('responds to user messages like a 1:1 assistant', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'What is Nexora?' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { content: string };
    expect(body.content).toContain('You asked');
    expect(body.content).toContain('Nexora');
  });

  it('maintains conversation history across turns', async () => {
    const beforeCount = room.length;

    await fetch(`http://127.0.0.1:${port}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'First message' }),
    });

    await fetch(`http://127.0.0.1:${port}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Second message' }),
    });

    // 2 turns × (user + agent) = +4 messages minimum
    expect(room.length - beforeCount).toBeGreaterThanOrEqual(4);
  });

  it('streams responses via SSE', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/messages/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Stream test' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data:');
  });
});
