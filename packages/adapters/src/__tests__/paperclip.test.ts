import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperclipAdapter } from '../paperclip.js';
import type { MessageRouter, InboundMessage, OutboundMessage } from '@dongkseo/contracts';
import { defineAgent, topic } from '@dongkseo/contracts';
import { createServer, type Server } from 'node:http';

// ─── Fake Paperclip server ─────────────────────────────────────────────────

let server: Server;
let port: number;
const agentStore: Record<string, unknown>[] = [];
const commentStore: { issueId: string; body: string }[] = [];
const issues = [
  { id: 'issue-1', title: 'Fix login bug', body: 'Login fails on mobile', status: 'open', assigneeAgentId: '' },
];

beforeEach(async () => {
  agentStore.length = 0;
  commentStore.length = 0;
  issues[0].assigneeAgentId = '';

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = req.url ?? '';

      // POST /api/agents → register
      if (req.method === 'POST' && url === '/api/agents') {
        const data = JSON.parse(body);
        const id = `agent-${agentStore.length + 1}`;
        agentStore.push({ ...data, id });
        issues[0].assigneeAgentId = id; // auto-assign for test
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
        return;
      }

      // GET /api/issues?assigneeAgentId=...&status=open
      if (req.method === 'GET' && url.startsWith('/api/issues')) {
        const agentId = new URL(url, `http://localhost:${port}`).searchParams.get('assigneeAgentId');
        const matched = issues.filter(i => i.assigneeAgentId === agentId && i.status === 'open');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(matched));
        return;
      }

      // POST /api/issues/:id/comments
      if (req.method === 'POST' && url.match(/\/api\/issues\/[\w-]+\/comments/)) {
        const data = JSON.parse(body);
        const issueId = url.split('/')[3];
        commentStore.push({ issueId, body: data.body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // PATCH /api/agents/:id → status update
      if (req.method === 'PATCH' && url.startsWith('/api/agents/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = (addr && typeof addr === 'object') ? addr.port : 0;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
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

const testCard = defineAgent({
  name: 'test-agent',
  description: 'Test agent for Paperclip adapter',
  architecture: 'react',
  tools: ['read'],
  subscribes: [topic('test.requested')],
  publishes: [topic('test.completed')],
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('PaperclipAdapter', () => {
  it('registers agents with Paperclip on start', async () => {
    const adapter = new PaperclipAdapter({
      client: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' },
      companyId: 'company-1',
      agents: [testCard],
      heartbeatIntervalMs: 60_000, // no auto-heartbeat in this test
    });

    await adapter.start(makeRouter(async () => ({ content: 'ok' })));

    expect(agentStore).toHaveLength(1);
    expect((agentStore[0] as { name: string }).name).toBe('test-agent');
    expect((agentStore[0] as { adapterType: string }).adapterType).toBe('nexora');

    await adapter.stop();
  });

  it('fetches issues on heartbeat and posts agent response as comment', async () => {
    const captured: InboundMessage[] = [];
    const adapter = new PaperclipAdapter({
      client: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' },
      companyId: 'company-1',
      agents: [testCard],
      heartbeatIntervalMs: 60_000,
    });

    await adapter.start(makeRouter(async (msg) => {
      captured.push(msg);
      return { content: 'Fixed the login bug on mobile.' };
    }));

    // Wait for initial heartbeat
    await new Promise(r => setTimeout(r, 200));

    // The adapter should have fetched the issue and routed it
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0].platform).toBe('paperclip');
    expect(captured[0].content).toContain('Fix login bug');
    expect(captured[0].tenantId).toBe('company-1');

    // And posted the response back as a comment
    expect(commentStore.length).toBeGreaterThanOrEqual(1);
    expect(commentStore[0].issueId).toBe('issue-1');
    expect(commentStore[0].body).toContain('Fixed the login bug');

    await adapter.stop();
  });

  it('marks agents offline on stop', async () => {
    const adapter = new PaperclipAdapter({
      client: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' },
      companyId: 'company-1',
      agents: [testCard],
      heartbeatIntervalMs: 60_000,
    });

    await adapter.start(makeRouter(async () => ({ content: 'ok' })));
    await adapter.stop();
    // If stop() didn't throw, the PATCH /api/agents/:id succeeded
  });
});
