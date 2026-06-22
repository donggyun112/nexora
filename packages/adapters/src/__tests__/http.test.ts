import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpAdapter } from '../http.js';
import type {
  MessageRouter,
  InboundMessage,
  OutboundMessage,
  OutboundChunk,
} from '@dongkseo/contracts';

let adapter: HttpAdapter;

afterEach(async () => {
  if (adapter) await adapter.stop();
});

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

async function postJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('HttpAdapter', () => {
  it('starts on auto-assigned port and serves /health', async () => {
    adapter = new HttpAdapter();
    await adapter.start(makeRouter(async () => ({ content: 'ok' })));
    expect(adapter.port()).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${adapter.port()}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('routes POST /messages to MessageRouter', async () => {
    adapter = new HttpAdapter();
    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: `received: ${msg.content}` };
    }));

    const result = await postJson(adapter.port()!, '/messages', {
      content: 'hello',
      userId: 'u1',
      displayName: 'User One',
      channelId: 'ch1',
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ content: 'received: hello' });
    expect(captured[0].content).toBe('hello');
    expect(captured[0].userId).toBe('u1');
    expect(captured[0].tenantId).toBe('default');
  });

  it('normalizes JSON file inputs before routing', async () => {
    adapter = new HttpAdapter();
    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));

    const data = Buffer.from('hello').toString('base64');
    const result = await postJson(adapter.port()!, '/messages', {
      content: 'read this',
      files: [{ name: '../note.txt', mimeType: 'text/plain; charset=utf-8', data }],
    });

    expect(result.status).toBe(200);
    expect(captured[0].files).toEqual([{
      type: 'file',
      name: 'note.txt',
      mimeType: 'text/plain',
      data,
      size: 5,
    }]);
  });

  it('accepts file-only requests', async () => {
    adapter = new HttpAdapter();
    const captured: InboundMessage[] = [];
    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'ok' };
    }));

    const result = await postJson(adapter.port()!, '/messages', {
      files: [{
        name: 'readme.md',
        mimeType: 'text/markdown',
        data: Buffer.from('# Title').toString('base64'),
      }],
    });

    expect(result.status).toBe(200);
    expect(captured[0].content).toBe('');
    expect(captured[0].files?.[0].name).toBe('readme.md');
  });

  it('rejects invalid file data', async () => {
    adapter = new HttpAdapter();
    await adapter.start(makeRouter(async () => ({ content: 'ok' })));

    const result = await postJson(adapter.port()!, '/messages', {
      content: 'bad file',
      files: [{ name: 'bad.txt', mimeType: 'text/plain', data: 'not base64!' }],
    });

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('base64');
  });

  it('rejects requests when resolveTenant returns null', async () => {
    adapter = new HttpAdapter({
      resolveTenant: (req) => req.headers.authorization === 'Bearer secret' ? 'tenant-A' : null,
    });
    await adapter.start(makeRouter(async () => ({ content: 'ok' })));

    const denied = await postJson(adapter.port()!, '/messages', { content: 'x' });
    expect(denied.status).toBe(401);

    const allowed = await postJson(adapter.port()!, '/messages', { content: 'x' }, {
      Authorization: 'Bearer secret',
    });
    expect(allowed.status).toBe(200);
  });

  it('returns 400 on missing content', async () => {
    adapter = new HttpAdapter();
    await adapter.start(makeRouter(async () => ({ content: 'ok' })));
    const res = await postJson(adapter.port()!, '/messages', {});
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('content');
  });

  it('streams chunks via /messages/stream', async () => {
    adapter = new HttpAdapter();
    await adapter.start(makeRouter(async () => ({ content: 'streamed' })));

    const res = await fetch(`http://127.0.0.1:${adapter.port()}/messages/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    const events = text.trim().split('\n\n').map(s => JSON.parse(s.replace(/^data: /, ''))) as OutboundChunk[];
    expect(events.some(e => e.type === 'text')).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
  });

  it('returns 404 for unknown routes', async () => {
    adapter = new HttpAdapter();
    await adapter.start(makeRouter(async () => ({ content: 'ok' })));
    const res = await fetch(`http://127.0.0.1:${adapter.port()}/nope`);
    expect(res.status).toBe(404);
  });
});
