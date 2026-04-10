/**
 * E2E 통합 테스트:
 *
 *   curl POST /messages
 *     → HttpAdapter
 *     → GatewayRouter (transport.request)
 *     → LocalTransport publish 'echo.requested'
 *     → bootstrapped echo-agent receives
 *     → ContextLoader builds context for tenant
 *     → AgentRunner.execute (mock LLM)
 *     → publishes 'echo.completed' with replyTo
 *     → GatewayRouter resolves request
 *     → HttpAdapter sends JSON response
 *     → curl receives result
 *
 * 멀티테넌트: 두 다른 tenantId로 호출하면 ContextLoader가 다른 컨텍스트를 주입.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HttpAdapter } from '@nexora/adapters';
import { LocalTransport } from '@nexora/transport';
import { CoreContextLoader } from '@nexora/context';
import { AgentRunner, CoreToolExecutor, bootstrapAgent } from '@nexora/core';
import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMResponse,
  AgentArchitecture,
  AgentEvent,
  RuntimeServices,
  AgentInput,
  ToolContext,
  AgentCard,
  TopicString,
} from '@nexora/contracts';
import { GatewayRouter } from '../router.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-e2e-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

class StaticLLM implements LLMProvider {
  constructor(private readonly text: string) {}
  async *stream(_m: LLMMessage[], _o?: LLMOptions): AsyncGenerator<LLMChunk> {
    yield { type: 'text_delta', delta: this.text };
    yield { type: 'done', content: this.text, stopReason: 'end_turn' };
  }
  async complete(_m: LLMMessage[], _o?: LLMOptions): Promise<LLMResponse> {
    return { content: this.text, model: 'mock', stopReason: 'end_turn' };
  }
}

const echoArch: AgentArchitecture = {
  name: 'echo',
  async *loop(services: RuntimeServices, input: AgentInput): AsyncGenerator<AgentEvent> {
    const r = await services.llm.complete(
      [{ role: 'user', content: input.prompt }],
      { systemPrompt: undefined },
    );
    yield { type: 'text', text: r.content };
    yield { type: 'done', content: r.content, toolCalls: [] };
  },
};

const toolContext: ToolContext = {
  tenantId: 'default',
  workdir: '/tmp',
  secrets: { get: async () => undefined },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

describe('Phase 5 E2E: HTTP → Gateway → Transport → Agent → reply', () => {
  it('curl-style POST flows through full stack and returns agent response', async () => {
    // Setup context tree
    fs.mkdirSync(path.join(tmpDir, 'personas'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'personas', 'echo-agent.md'), 'You are echo.');

    const transport = new LocalTransport();
    const contextLoader = new CoreContextLoader({ root: tmpDir });

    // 1. Bootstrap echo-agent on the transport
    const card: AgentCard = {
      name: 'echo-agent',
      version: '0.1.0',
      description: 'Echo via gateway',
      capabilities: ['echo'],
      subscribes: ['echo.requested'],
      publishes: ['echo.completed'],
      tools: [],
      architecture: 'echo',
    };

    const running = await bootstrapAgent({
      card,
      contextLoader,
      transport,
      createRuntime: ({ context }) => new AgentRunner({
        architecture: echoArch,
        llm: new StaticLLM('echoed: hello'),
        // Per-request ToolContext rebuilt from tenant runtime
        tools: new CoreToolExecutor({
          tools: [],
          context: {
            tenantId: context.tenantId,
            workdir: context.runtime.workdir,
            secrets: { get: async () => undefined },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
          },
        }),
        idleTimeoutMs: context.limits.maxExecutionMs,
      }),
      toAgentInput: (env) => {
        const p = env.payload as { prompt: string };
        return { prompt: p.prompt };
      },
    });

    // 2. Gateway router → transport.request
    const gatewayRouter = new GatewayRouter({
      transport,
      defaultTopic: 'echo.requested' as TopicString,
      timeoutMs: 5000,
    });

    // 3. HTTP adapter on top of gateway
    const adapter = new HttpAdapter({
      resolveTenant: () => 'tenant-A',
    });
    await adapter.start(gatewayRouter);

    // 4. curl-style request
    const res = await fetch(`http://127.0.0.1:${adapter.port()}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'hello',
        userId: 'u1',
        displayName: 'User',
        channelId: 'ch1',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { content: string };
    expect(body.content).toBe('echoed: hello');

    await adapter.stop();
    await running.shutdown();
    await transport.close();
  });

  it('different tenants get independent contexts via the same agent', async () => {
    // tenant-A: custom persona
    fs.mkdirSync(path.join(tmpDir, 'personas'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'tenants', 'tenant-A', 'personas'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'personas', 'echo-agent.md'), 'default echo');
    fs.writeFileSync(
      path.join(tmpDir, 'tenants', 'tenant-A', 'personas', 'echo-agent.md'),
      'TENANT-A SPECIAL',
    );

    const transport = new LocalTransport();
    const contextLoader = new CoreContextLoader({ root: tmpDir });

    // Capture which persona was loaded
    const observedPersonas: string[] = [];

    const card: AgentCard = {
      name: 'echo-agent',
      version: '0.1.0',
      description: '',
      capabilities: [],
      subscribes: ['echo.requested'],
      publishes: ['echo.completed'],
      tools: [],
      architecture: 'echo',
    };

    const running = await bootstrapAgent({
      card,
      contextLoader,
      transport,
      createRuntime: ({ context }) => {
        observedPersonas.push(`${context.tenantId}::${context.systemPrompt}`);
        // Return result that includes tenant info so we can verify
        return new AgentRunner({
          architecture: echoArch,
          llm: new StaticLLM(`from ${context.tenantId}`),
          tools: new CoreToolExecutor({
            tools: [],
            context: {
              tenantId: context.tenantId,
              workdir: context.runtime.workdir,
              secrets: { get: async () => undefined },
              logger: { info: () => {}, warn: () => {}, error: () => {} },
            },
          }),
          idleTimeoutMs: context.limits.maxExecutionMs,
        });
      },
      toAgentInput: (env) => ({ prompt: (env.payload as { prompt: string }).prompt }),
    });

    let currentTenant = 'tenant-A';
    const gatewayRouter = new GatewayRouter({
      transport,
      defaultTopic: 'echo.requested' as TopicString,
      timeoutMs: 5000,
    });

    const adapter = new HttpAdapter({
      resolveTenant: () => currentTenant,
    });
    await adapter.start(gatewayRouter);

    // tenant-A request
    let res = await fetch(`http://127.0.0.1:${adapter.port()}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect((await res.json() as { content: string }).content).toBe('from tenant-A');

    // tenant-B request
    currentTenant = 'tenant-B';
    res = await fetch(`http://127.0.0.1:${adapter.port()}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect((await res.json() as { content: string }).content).toBe('from tenant-B');

    // Verify ContextLoader was called with each tenant
    const tenantsObserved = observedPersonas.map(p => p.split('::')[0]).sort();
    expect(tenantsObserved).toEqual(['tenant-A', 'tenant-B']);

    // Tenant-A persona should differ from default
    const tenantAPrompt = observedPersonas.find(p => p.startsWith('tenant-A::'));
    const tenantBPrompt = observedPersonas.find(p => p.startsWith('tenant-B::'));
    expect(tenantAPrompt).toContain('TENANT-A SPECIAL');
    expect(tenantBPrompt).toContain('default echo');

    await adapter.stop();
    await running.shutdown();
    await transport.close();
  });
});
