import { describe, it, expect, vi } from 'vitest';
import { SlackAdapter } from '../slack.js';
import type { SlackClientLike, SlackMessageEvent } from '../slack.js';
import type { MessageRouter, InboundMessage, OutboundMessage } from '@dongkseo/contracts';

function makeFakeClient(): SlackClientLike & {
  fire: (event: SlackMessageEvent) => Promise<void>;
  lastSaid: string[];
} {
  let handler: ((event: SlackMessageEvent, say: (text: string) => Promise<void>) => Promise<void>) | null = null;
  const lastSaid: string[] = [];
  return {
    lastSaid,
    onMessage(h) { handler = h; },
    async postMessage(_channel, text) { lastSaid.push(text); },
    async fire(event) {
      if (handler) {
        await handler(event, async (text) => { lastSaid.push(text); });
      }
    },
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

describe('SlackAdapter', () => {
  it('routes Slack messages to the MessageRouter', async () => {
    const client = makeFakeClient();
    const adapter = new SlackAdapter({ client });

    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'agent reply' };
    }));

    await client.fire({
      text: 'hello bot',
      user: 'U123',
      channel: 'C456',
      team: 'T789',
      ts: '1234567890.123456',
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].platform).toBe('slack');
    expect(captured[0].channelId).toBe('C456');
    expect(captured[0].userId).toBe('U123');
    expect(captured[0].tenantId).toBe('T789');
    expect(client.lastSaid).toContain('agent reply');
    await adapter.stop();
  });

  it('ignores bot messages', async () => {
    const client = makeFakeClient();
    const adapter = new SlackAdapter({ client });

    let called = false;
    await adapter.start(makeRouter(async () => {
      called = true;
      return { content: 'x' };
    }));

    await client.fire({
      text: 'from bot',
      user: 'U123',
      channel: 'C456',
      ts: '1',
      bot_id: 'B999',
    });

    expect(called).toBe(false);
    await adapter.stop();
  });

  it('uses resolveTenant to map team → tenantId', async () => {
    const client = makeFakeClient();
    const adapter = new SlackAdapter({
      client,
      resolveTenant: (teamId) => teamId === 'T-good' ? 'tenant-ok' : null,
    });

    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));

    await client.fire({ text: 'hi', user: 'U1', channel: 'C1', team: 'T-good', ts: '1' });
    await client.fire({ text: 'hi', user: 'U1', channel: 'C1', team: 'T-bad', ts: '2' });

    expect(captured).toHaveLength(1);
    expect(captured[0].tenantId).toBe('tenant-ok');
    await adapter.stop();
  });

  it('uses thread_ts as conversationId when available', async () => {
    const client = makeFakeClient();
    const adapter = new SlackAdapter({ client });

    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));

    await client.fire({
      text: 'in thread',
      user: 'U1',
      channel: 'C1',
      ts: '100',
      thread_ts: '99',
    });

    expect(captured[0].conversationId).toBe('99');
    await adapter.stop();
  });

  it('splits long responses', async () => {
    const client = makeFakeClient();
    const adapter = new SlackAdapter({ client, maxMessageLength: 50 });

    await adapter.start(makeRouter(async () => ({
      content: 'A'.repeat(120),
    })));

    await client.fire({ text: 'long', user: 'U1', channel: 'C1', ts: '1' });

    expect(client.lastSaid.length).toBeGreaterThan(1);
    await adapter.stop();
  });

  it('handles errors gracefully', async () => {
    const client = makeFakeClient();
    const adapter = new SlackAdapter({ client });

    await adapter.start({
      async route() { throw new Error('boom'); },
      async routeStream() { throw new Error('boom'); },
    });

    await client.fire({ text: 'crash', user: 'U1', channel: 'C1', ts: '1' });

    expect(client.lastSaid.some(s => s.includes('Error'))).toBe(true);
    await adapter.stop();
  });
});
