/**
 * E2E Test — full pipeline verification.
 *
 * Tests the complete flow:
 *   HTTP request → HttpAdapter → GatewayRouter → Transport →
 *   Bootstrap → AgentRunner → ReAct → Tools → Response
 *
 * No API keys needed — uses SmartMockLLM.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { defineAgent, topic } from '@nexora/contracts';
import { bootstrapAgent, AgentRunner, CoreToolExecutor } from '@nexora/core';
import { createReactArchitecture } from '@nexora/architectures';
import { createReadTool, createGrepTool } from '@nexora/tools';
import { LocalTransport } from '@nexora/transport';
import { HttpAdapter } from '@nexora/adapters';
import { GatewayRouter } from '@nexora/gateway';
import { SmartMockLLM } from './mock-llm.js';
import type { ContextLoader, AgentContext } from '@nexora/contracts';
import type { RunningAgent } from '@nexora/core';

let http: HttpAdapter;
let transport: LocalTransport;
let agents: RunningAgent[];
let port: number;

beforeAll(async () => {
  const llm = new SmartMockLLM();
  transport = new LocalTransport();

  const card = defineAgent({
    name: 'test-agent',
    version: '0.1.0',
    description: 'E2E test agent',
    architecture: 'react',
    tools: ['read', 'grep'],
    capabilities: ['general'],
    subscribes: [topic('test.requested')],
    publishes: [topic('test.completed')],
  });

  const contextLoader: ContextLoader = {
    async load(): Promise<AgentContext> {
      return {
        tenantId: 'test',
        systemPrompt: 'You are a test agent.',
        tools: [],
        limits: {},
        runtime: { workdir: process.cwd() },
      } as unknown as AgentContext;
    },
  };

  const tools = [createReadTool(), createGrepTool()];

  const agent = await bootstrapAgent({
    card,
    contextLoader,
    transport,
    createRuntime: () => new AgentRunner({
      architecture: createReactArchitecture({ systemPrompt: 'Test agent.' }),
      llm,
      tools: new CoreToolExecutor({
        tools,
        context: {
          tenantId: 'test',
          workdir: process.cwd(),
          secrets: { get: async () => undefined },
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        },
      }),
    }),
    toAgentInput: (env) => ({
      prompt: (env.payload as { prompt?: string }).prompt ?? '',
    }),
  });
  agents = [agent];

  const router = new GatewayRouter({
    transport,
    defaultTopic: topic('test.requested'),
    timeoutMs: 10_000,
  });

  http = new HttpAdapter({ port: 0, host: '127.0.0.1' });
  await http.start(router);
  port = http.port()!;
});

afterAll(async () => {
  await http.stop();
  for (const a of agents) await a.shutdown();
  await transport.close();
});

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('E2E: HTTP → Agent → Response', () => {
  it('GET /health returns 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  it('POST /messages with "hello" returns agent response', async () => {
    const res = await post('/messages', { content: 'hello' });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: string };
    expect(body.content).toBeTruthy();
    expect(body.content.toLowerCase()).toContain('nexora');
  });

  it('POST /messages with "who are you" returns identity', async () => {
    const res = await post('/messages', { content: 'who are you' });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: string };
    expect(body.content).toContain('agent');
  });

  it('POST /messages with "help" returns capabilities', async () => {
    const res = await post('/messages', { content: 'help' });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: string };
    expect(body.content.length).toBeGreaterThan(20);
  });

  it('POST /messages with empty content returns 400', async () => {
    const res = await post('/messages', { content: '' });
    expect(res.status).toBe(400);
  });

  it('POST /messages/stream returns SSE chunks', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/messages/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('data:');
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it('handles concurrent requests', async () => {
    const requests = Array.from({ length: 5 }, (_, i) =>
      post('/messages', { content: `hello ${i}` }),
    );
    const responses = await Promise.all(requests);

    for (const res of responses) {
      expect(res.status).toBe(200);
      const body = await res.json() as { content: string };
      expect(body.content).toBeTruthy();
    }
  });
});
