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

  it('builds a hermes-style session key as conversationId', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({ client });

    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));

    client.fire(makeFakeMessage('hi', {
      guildId: 'guild-1',
      channelId: 'ch-1',
      author: { id: 'user-7', username: 'u', bot: false },
    }));
    await new Promise(r => setTimeout(r, 30));

    expect(captured[0].conversationId).toBe('agent:main:discord:channel:ch-1:user-7');
    await adapter.stop();
  });

  it('shares thread sessions across users by default', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({ client });

    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));

    const baseChannel = {
      sendTyping: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      isThread: () => true,
      parentId: 'parent-ch',
    };

    client.fire(makeFakeMessage('a', {
      guildId: 'g', channelId: 'thread-1',
      author: { id: 'user-A', username: 'a', bot: false },
      channel: baseChannel,
    }));
    client.fire(makeFakeMessage('b', {
      guildId: 'g', channelId: 'thread-1',
      author: { id: 'user-B', username: 'b', bot: false },
      channel: baseChannel,
    }));
    await new Promise(r => setTimeout(r, 30));

    expect(captured[0].conversationId).toBe('agent:main:discord:channel:parent-ch:thread-1');
    expect(captured[1].conversationId).toBe(captured[0].conversationId);
    expect(captured[0].metadata?.threadId).toBe('thread-1');
    expect(captured[0].metadata?.parentChannelId).toBe('parent-ch');
    await adapter.stop();
  });

  it('isolates threads per user when threadSessionsPerUser=true', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({ client, threadSessionsPerUser: true });

    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));

    const baseChannel = {
      sendTyping: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      isThread: () => true,
      parentId: 'parent-ch',
    };

    client.fire(makeFakeMessage('a', {
      guildId: 'g', channelId: 'th',
      author: { id: 'user-A', username: 'a', bot: false },
      channel: baseChannel,
    }));
    client.fire(makeFakeMessage('b', {
      guildId: 'g', channelId: 'th',
      author: { id: 'user-B', username: 'b', bot: false },
      channel: baseChannel,
    }));
    await new Promise(r => setTimeout(r, 30));

    expect(captured[0].conversationId).not.toBe(captured[1].conversationId);
    await adapter.stop();
  });

  it('drops messages from channels not in the allowlist', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({
      client,
      allowedChannels: ['ch-allowed'],
    });

    const captured: InboundMessage[] = [];
    const rejected: string[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));
    // Re-create adapter with onUnauthorized hook
    await adapter.stop();
    const adapter2 = new DiscordAdapter({
      client,
      allowedChannels: ['ch-allowed'],
      onUnauthorized: (_m, reason) => rejected.push(reason),
    });
    await adapter2.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));

    client.fire(makeFakeMessage('hi', { channelId: 'ch-other' }));
    client.fire(makeFakeMessage('hi', { channelId: 'ch-allowed' }));
    await new Promise(r => setTimeout(r, 30));

    expect(captured).toHaveLength(1);
    expect(captured[0].channelId).toBe('ch-allowed');
    expect(rejected).toContain('channel not in allowlist');
    await adapter2.stop();
  });

  it('drops messages from ignored channels', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({
      client,
      ignoredChannels: ['ch-spam'],
    });

    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));

    client.fire(makeFakeMessage('hi', { channelId: 'ch-spam' }));
    client.fire(makeFakeMessage('hi', { channelId: 'ch-ok' }));
    await new Promise(r => setTimeout(r, 30));

    expect(captured).toHaveLength(1);
    expect(captured[0].channelId).toBe('ch-ok');
    await adapter.stop();
  });

  it('requires allowed role when allowedRoles is set', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({
      client,
      allowedRoles: ['role-mod'],
    });

    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));

    // No member info → reject
    client.fire(makeFakeMessage('hi'));
    // Member without the role → reject
    client.fire(makeFakeMessage('hi', { member: { roleIds: ['role-other'] } }));
    // Member with the role → accept
    client.fire(makeFakeMessage('hi', { member: { roleIds: ['role-other', 'role-mod'] } }));
    await new Promise(r => setTimeout(r, 30));

    expect(captured).toHaveLength(1);
    await adapter.stop();
  });

  it('treats DMs as guildId=null and builds a DM session key', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({ client });

    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));

    client.fire(makeFakeMessage('hi', {
      guildId: null,
      channelId: 'dm-1',
      author: { id: 'user-9', username: 'u', bot: false },
    }));
    await new Promise(r => setTimeout(r, 30));

    expect(captured[0].tenantId).toBe('dm');
    expect(captured[0].conversationId).toBe('agent:main:discord:dm:dm-1');
    await adapter.stop();
  });

  it('drives status reactions: thinking → tool → done on success', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({
      client,
      statusReactions: { debounceMs: 5, botEmoji: null },
    });

    const router: MessageRouter = {
      async route() { return { content: 'ok' }; },
      async routeStream(_msg, onChunk) {
        // Let setThinking debounce fire before tool_call.
        await new Promise((r) => setTimeout(r, 20));
        onChunk({ type: 'tool_call', name: 'exec' });
        await new Promise((r) => setTimeout(r, 20));
        onChunk({ type: 'text', text: 'done' });
        onChunk({ type: 'done', content: 'done' });
      },
    };

    await adapter.start(router);

    const react = vi.fn(async () => {});
    const removeOwnReaction = vi.fn(async () => {});
    const fakeMsg = makeFakeMessage('hello', { react, removeOwnReaction });

    client.fire(fakeMsg);
    await new Promise((r) => setTimeout(r, 100));

    const reacted = react.mock.calls.map((c) => c[0]);
    expect(reacted).toContain('\u{1F9E0}'); // 🧠 thinking
    expect(reacted).toContain('\u{1F4BB}'); // 💻 exec tool emoji
    expect(reacted[reacted.length - 1]).toBe('✅'); // done
    await adapter.stop();
  });

  it('drives status reactions: ❌ on router error', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({
      client,
      statusReactions: { debounceMs: 0, botEmoji: null },
    });

    const router: MessageRouter = {
      async route() { throw new Error('boom'); },
      async routeStream() { throw new Error('boom'); },
    };

    await adapter.start(router);

    const react = vi.fn(async () => {});
    const fakeMsg = makeFakeMessage('hello', { react });

    client.fire(fakeMsg);
    await new Promise((r) => setTimeout(r, 50));

    const reacted = react.mock.calls.map((c) => c[0]);
    expect(reacted[reacted.length - 1]).toBe('❌');
    await adapter.stop();
  });

  it('skips status reactions when statusReactions=false', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({
      client,
      statusReactions: false,
    });

    await adapter.start(makeRouter(async () => ({ content: 'ok' })));

    const react = vi.fn(async () => {});
    const fakeMsg = makeFakeMessage('hello', { react });

    client.fire(fakeMsg);
    await new Promise((r) => setTimeout(r, 30));

    expect(react).not.toHaveBeenCalled();
    await adapter.stop();
  });

  it('skips status reactions when message has no react method', async () => {
    const client = makeFakeClient();
    const adapter = new DiscordAdapter({
      client,
      statusReactions: { debounceMs: 0 },
    });

    await adapter.start(makeRouter(async () => ({ content: 'ok' })));

    // makeFakeMessage by default has no `react` method.
    const fakeMsg = makeFakeMessage('hello');
    expect(fakeMsg.react).toBeUndefined();
    client.fire(fakeMsg);
    await new Promise((r) => setTimeout(r, 30));

    // Without react support the controller is never created; no assertions
    // to make other than: it shouldn't throw and message routing still works.
    expect(fakeMsg.reply).toHaveBeenCalled();
    await adapter.stop();
  });
});
