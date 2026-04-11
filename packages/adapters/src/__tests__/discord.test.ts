import { describe, it, expect, vi } from 'vitest';
import { DiscordAdapter } from '../discord.js';
import type { DiscordClientLike, DiscordMessageLike } from '../discord.js';
import type { MessageRouter, InboundMessage, OutboundMessage, OutboundChunk } from '@nexora/contracts';

function makeFakeClient(): DiscordClientLike & { fire: (msg: DiscordMessageLike) => void } {
  const handlers: ((msg: DiscordMessageLike) => void)[] = [];
  return {
    user: { id: 'bot-123' },
    on(_event: string, handler: (msg: DiscordMessageLike) => void) { handlers.push(handler); },
    off(_event: string, handler: (msg: DiscordMessageLike) => void) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    },
    fire(msg: DiscordMessageLike) { for (const h of handlers) h(msg); },
  };
}

function makeFakeMessage(content: string, overrides: Partial<DiscordMessageLike> = {}): DiscordMessageLike {
  return {
    id: 'msg-1',
    content,
    author: { id: 'user-1', username: 'testuser', bot: false },
    channelId: 'ch-1',
    guildId: 'guild-1',
    mentions: { users: new Map() },
    reply: vi.fn(async () => {}),
    channel: {
      sendTyping: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    },
    ...overrides,
  };
}

function makeRouter(handler: (msg: InboundMessage) => Promise<OutboundMessage>): MessageRouter {
  return {
    async route(msg) { return handler(msg); },
    async routeStream(msg, onChunk) {
      const out = await handler(msg);
      onChunk({ type: 'text', text: out.content });
      onChunk({ type: 'done', content: out.content });
    },
  };
}

describe('DiscordAdapter', () => {
  it('routes Discord messages to the MessageRouter', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({ client });

    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'agent reply' };
    }));

    const fakeMsg = makeFakeMessage('hello bot');
    client.fire(fakeMsg);
    await new Promise(r => setTimeout(r, 50));

    expect(captured).toHaveLength(1);
    expect(captured[0].platform).toBe('discord');
    expect(captured[0].channelId).toBe('ch-1');
    expect(captured[0].userId).toBe('user-1');
    expect(captured[0].content).toBe('hello bot');
    expect(captured[0].tenantId).toBe('guild-1');

    expect(fakeMsg.reply).toHaveBeenCalledWith('agent reply');
    await adapter.stop();
  });

  it('ignores bot messages to prevent loops', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({ client });

    let called = false;
    await adapter.start(makeRouter(async () => {
      called = true;
      return { content: 'x' };
    }));

    const botMsg = makeFakeMessage('from bot', {
      author: { id: 'bot-1', username: 'other-bot', bot: true },
    });
    client.fire(botMsg);
    await new Promise(r => setTimeout(r, 30));

    expect(called).toBe(false);
    await adapter.stop();
  });

  it('uses resolveTenant to map guildId → tenantId', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({
      client,
      resolveTenant: (guildId) => guildId === 'guild-A' ? 'tenant-A' : null,
    });

    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));

    // guild-A → routed
    client.fire(makeFakeMessage('hi', { guildId: 'guild-A' }));
    // guild-B → dropped (resolveTenant returns null)
    client.fire(makeFakeMessage('hi', { guildId: 'guild-B' }));
    await new Promise(r => setTimeout(r, 50));

    expect(captured).toHaveLength(1);
    expect(captured[0].tenantId).toBe('tenant-A');
    await adapter.stop();
  });

  it('splits long responses to respect Discord char limit', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({ client, maxMessageLength: 50 });

    await adapter.start(makeRouter(async () => ({
      content: 'A'.repeat(120), // > 50, needs splitting
    })));

    const fakeMsg = makeFakeMessage('give me a long response');
    client.fire(fakeMsg);
    await new Promise(r => setTimeout(r, 50));

    // First chunk → reply, rest → channel.send
    expect(fakeMsg.reply).toHaveBeenCalled();
    expect(fakeMsg.channel.send).toHaveBeenCalled();
    await adapter.stop();
  });

  it('shows typing indicator while processing', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({ client });

    await adapter.start(makeRouter(async () => ({ content: 'done' })));

    const fakeMsg = makeFakeMessage('hello');
    client.fire(fakeMsg);
    await new Promise(r => setTimeout(r, 50));

    expect(fakeMsg.channel.sendTyping).toHaveBeenCalled();
    await adapter.stop();
  });

  it('handles router errors gracefully', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({ client });

    await adapter.start({
      async route() { throw new Error('router exploded'); },
      async routeStream(_msg, _onChunk) { throw new Error('router exploded'); },
    });

    const fakeMsg = makeFakeMessage('crash me');
    client.fire(fakeMsg);
    await new Promise(r => setTimeout(r, 50));

    expect(fakeMsg.reply).toHaveBeenCalledWith(expect.stringContaining('Error'));
    await adapter.stop();
  });
});
