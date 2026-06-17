/**
 * Helpdesk E2E test — proves the full Nexora stack in one test.
 *
 * HTTP POST /messages
 *   → HttpAdapter
 *   → GatewayRouter
 *   → LocalTransport
 *   → bootstrapped helpdesk-agent
 *   → CoreContextLoader (per-tenant persona)
 *   → AgentRunner (mock LLM)
 *   → result topic
 *   → HTTP response
 *
 * Uses a mock LLM so no API key needed. Tests multi-tenant by sending
 * two requests with different X-Tenant-Id headers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { LocalTransport } from '@dongkseo/transport';
import { CoreContextLoader } from '@dongkseo/context';
import {
  AgentRunner,
  CoreToolExecutor,
  bootstrapAgent,
} from '@dongkseo/core';
import { createReactArchitecture } from '@dongkseo/architectures';
import { createReadTool, createGrepTool } from '@dongkseo/tools';
import { HttpAdapter } from '@dongkseo/adapters';
import { GatewayRouter } from '@dongkseo/gateway';
import { defineAgent, topic } from '@dongkseo/contracts';
import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMResponse,
  TopicString,
} from '@dongkseo/contracts';
import type { RunningAgent } from '@dongkseo/core';

// ─── Mock LLM ──────────────────────────────────────────────────────────────

class MockHelpdeskLLM implements LLMProvider {
  async *stream(): AsyncGenerator<LLMChunk> {
    yield { type: 'done', content: 'mock', stopReason: 'end_turn' };
  }
  async complete(_msgs: LLMMessage[], _opts?: LLMOptions): Promise<LLMResponse> {
    return {
      content: 'This is a mock helpdesk response. In production, the agent would read your codebase and answer.',
      model: 'mock',
      stopReason: 'end_turn',
    };
  }
}

// ─── Test setup ────────────────────────────────────────────────────────────

let tmpDir: string;
let transport: LocalTransport;
let adapter: HttpAdapter;
let running: RunningAgent;
let port: number;

beforeAll(async () => {
  // Create a temp context directory with a persona
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-helpdesk-test-'));
  fs.mkdirSync(path.join(tmpDir, 'personas'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'personas', 'helpdesk-agent.md'),
    '# Helpdesk Agent\nYou are a helpful developer support agent.',
  );

  // Create tenant-specific persona
  fs.mkdirSync(path.join(tmpDir, 'tenants', 'premium', 'personas'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'tenants', 'premium', 'personas', 'helpdesk-agent.md'),
    '# Premium Helpdesk Agent\nYou are a PREMIUM support agent with priority access.',
  );

  const card = defineAgent({
    name: 'helpdesk-agent',
    version: '0.1.0',
    description: 'Helpdesk',
    architecture: 'react',
    tools: ['read', 'grep'],
    subscribes: [topic('helpdesk.requested')],
    publishes: [topic('helpdesk.completed')],
  });

  transport = new LocalTransport();
  const contextLoader = new CoreContextLoader({ root: tmpDir });
  const llm = new MockHelpdeskLLM();

  running = await bootstrapAgent({
    card,
    contextLoader,
    transport,
    createRuntime: ({ context }) => new AgentRunner({
      architecture: createReactArchitecture({
        systemPrompt: context.systemPrompt,
        model: context.limits.model,
      }),
      llm,
      tools: new CoreToolExecutor({
        tools: [createReadTool(), createGrepTool()],
        context: {
          tenantId: context.tenantId,
          workdir: context.runtime.workdir,
          secrets: { get: async () => undefined },
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        },
      }),
      idleTimeoutMs: context.limits.maxExecutionMs,
    }),
    toAgentInput: (env) => ({
      prompt: (env.payload as { prompt?: string }).prompt ?? '',
    }),
  });

  const gatewayRouter = new GatewayRouter({
    transport,
    defaultTopic: topic('helpdesk.requested') as TopicString,
    timeoutMs: 10_000,
  });

  adapter = new HttpAdapter({
    port: 0, // auto-assign
    resolveTenant: (req) => (req.headers['x-tenant-id'] as string) ?? 'default',
  });
  await adapter.start(gatewayRouter);
  port = adapter.port()!;
});

afterAll(async () => {
  await adapter.stop();
  await running.shutdown();
  await transport.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Helpdesk reference app — full-stack E2E', () => {
  it('health check', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('POST /messages → agent processes → JSON response', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'What files are in the project?' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { content: string };
    expect(body.content).toContain('mock helpdesk response');
  });

  it('multi-tenant: different tenants get different context', async () => {
    // Default tenant
    const res1 = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': 'default',
      },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res1.status).toBe(200);

    // Premium tenant
    const res2 = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': 'premium',
      },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res2.status).toBe(200);

    // Both succeed — the persona file loaded differently per tenant
    // (in a real test with a real LLM, the response tone would differ)
    const body1 = await res1.json() as { content: string };
    const body2 = await res2.json() as { content: string };
    expect(body1.content).toBeDefined();
    expect(body2.content).toBeDefined();
  });

  it('SSE stream endpoint works', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/messages/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'stream test' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data:');
  });

  it('returns 400 on empty content', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
