/**
 * Bootstrap 통합 테스트.
 *
 * Inline mock Transport + ContextLoader로 부팅 → 메시지 처리 → 결과 발행 검증.
 */

import { describe, it, expect, vi } from 'vitest';
import { bootstrapAgent } from '../bootstrap.js';
import { AgentRunner } from '../runner.js';
import { CoreToolExecutor } from '../tool-executor.js';
import type {
  Transport,
  Subscription,
  RequestOptions,
  TopicString,
  MessageEnvelope,
  AgentCard,
  ContextLoader,
  AgentContext,
  AgentArchitecture,
  AgentEvent,
  RuntimeServices,
  AgentInput,
  ToolContext,
} from '@nexora/contracts';
import { matchTopic, messageId } from '@nexora/contracts';
import { MockLLMProvider } from './mock-llm.js';

class InlineTransport implements Transport {
  private readonly subs = new Map<number, { pattern: string; handler: (e: MessageEnvelope) => Promise<void> }>();
  private nextId = 0;
  public readonly published: MessageEnvelope[] = [];

  async publish(envelope: MessageEnvelope): Promise<void> {
    this.published.push(envelope);
    const matched = Array.from(this.subs.values()).filter(s =>
      matchTopic(s.pattern, envelope.topic as TopicString),
    );
    await Promise.all(matched.map(s => s.handler(envelope)));
  }

  subscribe(pattern: string, handler: (e: MessageEnvelope) => Promise<void>): Subscription {
    const id = this.nextId++;
    this.subs.set(id, { pattern, handler });
    return { unsubscribe: () => { this.subs.delete(id); } };
  }

  async request(_topic: TopicString, _payload: unknown, _options?: RequestOptions): Promise<MessageEnvelope> {
    throw new Error('not implemented in test');
  }

  async close(): Promise<void> {
    this.subs.clear();
  }
}

const inlineLoader: ContextLoader = {
  async load(tenantId, agentName) {
    return {
      tenantId,
      systemPrompt: `prompt for ${agentName}@${tenantId}`,
      persona: `${agentName} persona`,
      tools: ['echo'],
      limits: {
        maxExecutionMs: 60_000,
        maxTokens: 1000,
        model: 'mock',
        thinkingLevel: 'off',
        contextWindow: 200_000,
      },
      runtime: {
        today: '2024-01-01',
        weekday: 'Monday',
        thisWeek: '2024-01-01 ~ 2024-01-07',
        workdir: '/tmp',
      },
    } satisfies AgentContext;
  },
};

const echoArch: AgentArchitecture = {
  name: 'echo',
  async *loop(services: RuntimeServices, input: AgentInput): AsyncGenerator<AgentEvent> {
    const resp = await services.llm.complete([{ role: 'user', content: input.prompt }]);
    if (resp.content) yield { type: 'text', text: resp.content };
    yield { type: 'done', content: resp.content, toolCalls: [] };
  },
};

const toolContext: ToolContext = {
  tenantId: 'test',
  workdir: '/tmp',
  secrets: { get: async () => undefined },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

describe('bootstrapAgent', () => {
  it('subscribes, processes messages, publishes result', async () => {
    const transport = new InlineTransport();
    const card: AgentCard = {
      name: 'echo-agent',
      version: '0.1.0',
      description: 'Echo',
      capabilities: ['echo'],
      subscribes: ['echo.requested'],
      publishes: ['echo.completed'],
      tools: ['echo'],
      architecture: 'echo',
    };

    const llm = new MockLLMProvider([{ text: 'echoed: hi' }]);

    // Track what the factory saw so we can assert the context actually flowed through.
    const observed: { tenantId: string; workdir: string; systemPrompt: string }[] = [];

    const running = await bootstrapAgent({
      card,
      contextLoader: inlineLoader,
      transport,
      createRuntime: ({ context }) => {
        observed.push({
          tenantId: context.tenantId,
          workdir: context.runtime.workdir,
          systemPrompt: context.systemPrompt,
        });
        return new AgentRunner({
          architecture: echoArch,
          llm,
          // Per-request ToolContext built from tenant runtime (what the scaffold does).
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
      toAgentInput: (env) => ({
        prompt: (env.payload as { prompt: string }).prompt,
      }),
    });

    // Trigger
    await transport.publish({
      id: messageId(),
      topic: 'echo.requested',
      type: 'request',
      payload: { prompt: 'hi' },
      metadata: {
        traceId: 'trace-1',
        spanId: 'span-1',
        conversationId: 'conv-1',
        tenantId: 'tenant-X',
        timestamp: Date.now(),
      },
    });

    // Wait for async work
    await new Promise(r => setTimeout(r, 20));

    // Verify result was published
    const result = transport.published.find(p => p.topic === 'echo.completed');
    expect(result).toBeDefined();
    expect(result?.type).toBe('result');
    expect(result?.metadata.replyTo).toBeDefined();
    expect(result?.metadata.parentSpanId).toBe('span-1');
    expect(result?.metadata.traceId).toBe('trace-1');
    expect(result?.metadata.tenantId).toBe('tenant-X');
    expect(result?.metadata.sourceInstanceId).toBe('echo-agent');

    const payload = result?.payload as { content: string; toolCalls: unknown[] };
    expect(payload.content).toBe('echoed: hi');

    // Fix #6 assertion: the context ACTUALLY flowed through createRuntime.
    expect(observed).toHaveLength(1);
    expect(observed[0].tenantId).toBe('tenant-X');
    expect(observed[0].systemPrompt).toContain('echo-agent@tenant-X');

    await running.shutdown();
  });

  it('publishes <topic>.failed on errors', async () => {
    const transport = new InlineTransport();
    const card: AgentCard = {
      name: 'failing-agent',
      version: '0.1.0',
      description: 'Always fails',
      capabilities: [],
      subscribes: ['fail.requested'],
      publishes: ['fail.completed'],
      tools: [],
      architecture: 'echo',
    };

    const broken: ContextLoader = {
      async load(): Promise<AgentContext> {
        throw new Error('context loader exploded');
      },
    };

    const llm = new MockLLMProvider([]);

    const running = await bootstrapAgent({
      card,
      contextLoader: broken,
      transport,
      createRuntime: ({ context }) => new AgentRunner({
        architecture: echoArch,
        llm,
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
      toAgentInput: () => ({ prompt: 'x' }),
    });

    await transport.publish({
      id: messageId(),
      topic: 'fail.requested',
      type: 'request',
      payload: {},
      metadata: {
        traceId: 't',
        spanId: 's',
        conversationId: 'c',
        tenantId: 'x',
        timestamp: Date.now(),
      },
    });

    await new Promise(r => setTimeout(r, 20));

    const failed = transport.published.find(p => p.topic === 'fail.requested.failed');
    expect(failed).toBeDefined();
    expect((failed?.payload as { error: string }).error).toContain('exploded');

    await running.shutdown();
  });

  it('routes different tenants through ContextLoader independently', async () => {
    const transport = new InlineTransport();
    const card: AgentCard = {
      name: 'router-agent',
      version: '0.1.0',
      description: 'Multi-tenant',
      capabilities: [],
      subscribes: ['route.requested'],
      publishes: ['route.completed'],
      tools: [],
      architecture: 'echo',
    };

    const loaderSpy = vi.fn(inlineLoader.load);
    const spyingLoader: ContextLoader = { load: loaderSpy };

    const llm = new MockLLMProvider([
      { text: 'r1' },
      { text: 'r2' },
    ]);

    // Record what tenantId each AgentRunner was built with, so we can verify
    // per-request factory invocation uses the right context.
    const observedTenants: string[] = [];

    const running = await bootstrapAgent({
      card,
      contextLoader: spyingLoader,
      transport,
      createRuntime: ({ context }) => {
        observedTenants.push(context.tenantId);
        return new AgentRunner({
          architecture: echoArch,
          llm,
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
      toAgentInput: (env) => ({ prompt: (env.payload as { p: string }).p }),
    });

    for (const tenant of ['tenant-A', 'tenant-B']) {
      await transport.publish({
        id: messageId(),
        topic: 'route.requested',
        type: 'request',
        payload: { p: `from ${tenant}` },
        metadata: {
          traceId: 't',
          spanId: 's',
          conversationId: 'c',
          tenantId: tenant,
          timestamp: Date.now(),
        },
      });
    }

    await new Promise(r => setTimeout(r, 30));

    expect(loaderSpy).toHaveBeenCalledTimes(2);
    expect(loaderSpy.mock.calls.map(c => c[0]).sort()).toEqual(['tenant-A', 'tenant-B']);

    // Fix #6 assertion: createRuntime was called with the right per-request context
    expect(observedTenants.sort()).toEqual(['tenant-A', 'tenant-B']);

    const results = transport.published.filter(p => p.topic === 'route.completed');
    expect(results).toHaveLength(2);
    expect(results.map(r => r.metadata.tenantId).sort()).toEqual(['tenant-A', 'tenant-B']);

    await running.shutdown();
  });
});
