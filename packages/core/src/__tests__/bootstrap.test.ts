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
  EventTransport,
  Subscription,
  RequestOptions,
  TopicString,
  TransportDescription,
  AgentRegistry,
  MessageEnvelope,
  AgentCard,
  ContextLoader,
  AgentContext,
  AgentArchitecture,
  AgentEvent,
  RuntimeServices,
  AgentInput,
  ToolContext,
} from '@dongkseo/contracts';
import { matchTopic, messageId } from '@dongkseo/contracts';
import { MockLLMProvider } from './mock-llm.js';

class InlineTransport implements EventTransport {
  private readonly subs = new Map<number, { pattern: string; handler: (e: MessageEnvelope) => Promise<void> }>();
  private nextId = 0;
  public readonly published: MessageEnvelope[] = [];

  describe(): TransportDescription {
    return {
      kind: 'inline-test',
      deliveryGuarantee: 'at-most-once',
      durable: false,
      supportsConsumerGroups: false,
      notes: 'Synchronous in-test transport, publish runs handlers inline',
    };
  }

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

class FakeRegistry implements AgentRegistry {
  public readonly registered: AgentCard[] = [];
  public readonly unregistered: string[] = [];

  async register(card: AgentCard): Promise<void> { this.registered.push(card); }
  async unregister(name: string): Promise<void> { this.unregistered.push(name); }
  async get(name: string): Promise<AgentCard | null> {
    return this.registered.find(c => c.name === name) ?? null;
  }
  async list(): Promise<AgentCard[]> { return [...this.registered]; }
  async findByCapability(cap: string): Promise<AgentCard[]> {
    return this.registered.filter(c => c.capabilities.includes(cap));
  }
  async findBySubscription(topic: string): Promise<AgentCard[]> {
    return this.registered.filter(c =>
      c.subscribes.some(p => matchTopic(p, topic as TopicString)),
    );
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

  // The scaffold applies `context.tools` as a tool allowlist inside
  // createRuntime. This test mirrors the scaffold's filter logic and verifies
  // that a tool NOT in the tenant allowlist is truly unreachable via
  // services.tools.execute().
  it('tenant tool allowlist is actually applied — filtered tools are unreachable', async () => {
    const transport = new InlineTransport();
    const card: AgentCard = {
      name: 'filter-agent',
      version: '0.1.0',
      description: 'Filter',
      capabilities: [],
      subscribes: ['filter.requested'],
      publishes: ['filter.completed'],
      tools: ['echo', 'cat'],
      architecture: 'filter',
    };

    // Two tools — the tenant only allowlists 'echo', 'cat' must be rejected.
    const echoTool = {
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<{ type: 'text'; text: string }> => ({ type: 'text', text: 'echo-ran' }),
    };
    const catTool = {
      name: 'cat',
      description: 'cat',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<{ type: 'text'; text: string }> => ({ type: 'text', text: 'cat-should-not-run' }),
    };

    // Tenant-aware context loader: only 'echo' is allowed for tenant-filter.
    const filteringLoader: ContextLoader = {
      async load(tenantId, agentName): Promise<AgentContext> {
        return {
          tenantId,
          systemPrompt: `${agentName}@${tenantId}`,
          persona: 'filter persona',
          tools: ['echo'], // cat is NOT allowed
          limits: {
            maxExecutionMs: 60_000,
            maxTokens: 1000,
            model: 'mock',
            thinkingLevel: 'off',
            contextWindow: 200_000,
          },
          runtime: {
            today: '2026-04-11',
            weekday: 'Saturday',
            thisWeek: '2026-04-06 ~ 2026-04-12',
            workdir: '/tmp',
          },
        };
      },
    };

    // Architecture that tries to call BOTH tools — we want to see cat
    // rejected while echo succeeds.
    const calls: { name: string; isError: boolean }[] = [];
    const dualCallArch: AgentArchitecture = {
      name: 'dual-call',
      async *loop(services: RuntimeServices, _input: AgentInput): AsyncGenerator<AgentEvent> {
        for (const name of ['echo', 'cat']) {
          const result = await services.tools.execute(name, `call-${name}`, {});
          const isError = (result as { type?: string }).type === 'error';
          calls.push({ name, isError });
          yield { type: 'tool_call', id: `call-${name}`, name, input: {} };
          yield { type: 'tool_result', id: `call-${name}`, name, result, isError };
        }
        yield { type: 'done', content: 'tested both', toolCalls: [] };
      },
    };

    const running = await bootstrapAgent({
      card,
      contextLoader: filteringLoader,
      transport,
      createRuntime: ({ context }) => {
        // Mirror the scaffold's filter logic exactly.
        const allowed = context.tools.length > 0 ? new Set(context.tools) : null;
        const allTools = [echoTool, catTool];
        const filtered = allowed
          ? allTools.filter(t => allowed.has(t.name))
          : allTools;
        return new AgentRunner({
          architecture: dualCallArch,
          llm: new MockLLMProvider([]),
          tools: new CoreToolExecutor({
            tools: filtered,
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
      toAgentInput: () => ({ prompt: 'test' }),
    });

    await transport.publish({
      id: messageId(),
      topic: 'filter.requested',
      type: 'request',
      payload: {},
      metadata: {
        traceId: 't',
        spanId: 's',
        conversationId: 'c',
        tenantId: 'tenant-filter',
        timestamp: Date.now(),
      },
    });

    await new Promise(r => setTimeout(r, 30));

    // Assertion: echo must have run successfully, cat must have been rejected
    // because it was not in context.tools.
    expect(calls).toHaveLength(2);
    const echoCall = calls.find(c => c.name === 'echo');
    const catCall = calls.find(c => c.name === 'cat');
    expect(echoCall).toEqual({ name: 'echo', isError: false });
    expect(catCall).toEqual({ name: 'cat', isError: true });

    await running.shutdown();
  });

  // P1-1a: bootstrap auto-registers to an optional AgentRegistry and
  // unregisters on shutdown, so other components (workflow engine, gateway)
  // can look the agent up by name without manual wiring.
  it('auto-registers with AgentRegistry on bootstrap and unregisters on shutdown', async () => {
    const transport = new InlineTransport();
    const registry = new FakeRegistry();
    const card: AgentCard = {
      name: 'registered-agent',
      version: '0.1.0',
      description: 'autoreg test',
      capabilities: ['x'],
      subscribes: ['reg.requested'],
      publishes: ['reg.completed'],
      tools: [],
      architecture: 'echo',
    };

    const llm = new MockLLMProvider([{ text: 'ok' }]);
    const running = await bootstrapAgent({
      card,
      contextLoader: inlineLoader,
      transport,
      registry,
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
      toAgentInput: () => ({ prompt: 'hi' }),
    });

    expect(registry.registered).toHaveLength(1);
    expect(registry.registered[0].name).toBe('registered-agent');

    await running.shutdown();

    expect(registry.unregistered).toEqual(['registered-agent']);
  });

  // P1-1b: publishes lint — if the agent would publish to a topic NOT in
  // card.publishes, bootstrap logs a warning (default) or throws (strict).
  // Failure topics (`<topic>.failed`) are always exempt.
  it('warns when result topic does not match card.publishes', async () => {
    const transport = new InlineTransport();
    const warnings: string[] = [];
    const card: AgentCard = {
      name: 'drift-agent',
      version: '0.1.0',
      description: 'publishes drift',
      capabilities: [],
      subscribes: ['drift.requested'],
      publishes: ['drift.completed'], // declared
      tools: [],
      architecture: 'echo',
    };

    const llm = new MockLLMProvider([{ text: 'ok' }]);
    const running = await bootstrapAgent({
      card,
      contextLoader: inlineLoader,
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
      toAgentInput: () => ({ prompt: 'hi' }),
      // Route to a topic that is NOT in card.publishes
      resultTopicFor: () => 'drift.unexpected',
      logger: {
        info: () => {},
        warn: (msg: string) => { warnings.push(msg); },
        error: () => {},
        debug: () => {},
      },
    });

    await transport.publish({
      id: messageId(),
      topic: 'drift.requested',
      type: 'request',
      payload: {},
      metadata: {
        traceId: 't', spanId: 's', conversationId: 'c',
        tenantId: 'tenant-x', timestamp: Date.now(),
      },
    });
    await new Promise(r => setTimeout(r, 20));

    expect(warnings.some(w => w.includes('drift.unexpected'))).toBe(true);
    expect(warnings.some(w => w.includes('drift.completed'))).toBe(true);
    await running.shutdown();
  });

  it('publishes lint strict mode throws instead of warning', async () => {
    const transport = new InlineTransport();
    const card: AgentCard = {
      name: 'strict-agent',
      version: '0.1.0',
      description: 'strict drift',
      capabilities: [],
      subscribes: ['strict.requested'],
      publishes: ['strict.completed'],
      tools: [],
      architecture: 'echo',
    };

    const llm = new MockLLMProvider([{ text: 'ok' }]);
    const running = await bootstrapAgent({
      card,
      contextLoader: inlineLoader,
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
      toAgentInput: () => ({ prompt: 'hi' }),
      resultTopicFor: () => 'strict.wrong',
      strictPublishLint: true,
    });

    await transport.publish({
      id: messageId(),
      topic: 'strict.requested',
      type: 'request',
      payload: {},
      metadata: {
        traceId: 't', spanId: 's', conversationId: 'c',
        tenantId: 'tenant-x', timestamp: Date.now(),
      },
    });
    await new Promise(r => setTimeout(r, 20));

    // In strict mode, the lint throws inside handleMessage. That error is
    // caught by the outer try/catch and routed to the `.failed` topic.
    const failed = transport.published.find(p => p.topic === 'strict.requested.failed');
    expect(failed).toBeDefined();
    expect((failed?.payload as { error: string }).error).toMatch(/strict\.wrong/);
    await running.shutdown();
  });

  // Tenant isolation: bootstrapAgent({ tenantId }) silently drops messages
  // addressed to other tenants. Messages to the matching tenant still flow.
  it('tenant isolation: drops messages for other tenants', async () => {
    const transport = new InlineTransport();
    const card: AgentCard = {
      name: 'tenant-scoped',
      version: '0.1.0',
      description: '',
      capabilities: [],
      subscribes: ['tenant-work.requested'],
      publishes: ['tenant-work.completed'],
      tools: [],
      architecture: 'echo',
    };

    const seen: string[] = [];
    const observingLoader: ContextLoader = {
      async load(tenantId, agentName) {
        seen.push(tenantId);
        return {
          tenantId, systemPrompt: `${agentName}@${tenantId}`, persona: '',
          tools: [],
          limits: {
            maxExecutionMs: 60_000, maxTokens: 1000, model: 'mock',
            thinkingLevel: 'off', contextWindow: 200_000,
          },
          runtime: { today: '2026-04-11', weekday: 'Sat', thisWeek: '', workdir: '/tmp' },
        };
      },
    };

    const llm = new MockLLMProvider([{ text: 'ok-A' }, { text: 'ok-B' }]);
    const running = await bootstrapAgent({
      card,
      contextLoader: observingLoader,
      transport,
      tenantId: 'tenant-A', // ONLY tenant-A traffic
      createRuntime: ({ context }) => new AgentRunner({
        architecture: echoArch, llm,
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
      id: messageId(), topic: 'tenant-work.requested', type: 'request', payload: {},
      metadata: {
        traceId: 't', spanId: 's', conversationId: 'c',
        tenantId: 'tenant-A', timestamp: Date.now(),
      },
    });
    await transport.publish({
      id: messageId(), topic: 'tenant-work.requested', type: 'request', payload: {},
      metadata: {
        traceId: 't', spanId: 's', conversationId: 'c',
        tenantId: 'tenant-B', timestamp: Date.now(),
      },
    });
    await new Promise(r => setTimeout(r, 20));

    expect(seen).toEqual(['tenant-A']);
    const results = transport.published.filter(p => p.topic === 'tenant-work.completed');
    expect(results).toHaveLength(1);
    expect(results[0].metadata.tenantId).toBe('tenant-A');
    await running.shutdown();
  });

  // Schema validation: malformed input is routed to `<topic>.schema-rejected`
  // BEFORE any agent code runs.
  it('schema validation rejects malformed input to .schema-rejected topic', async () => {
    const transport = new InlineTransport();
    const card: AgentCard = {
      name: 'schema-agent',
      version: '0.1.0',
      description: '',
      capabilities: [],
      subscribes: ['schema.requested'],
      publishes: ['schema.completed'],
      tools: [],
      architecture: 'echo',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          priority: { type: 'integer', minimum: 0, maximum: 10 },
        },
        required: ['prompt', 'priority'],
      },
    };

    const llm = new MockLLMProvider([]);
    let runtimeInvoked = false;
    const running = await bootstrapAgent({
      card,
      contextLoader: inlineLoader,
      transport,
      createRuntime: () => {
        runtimeInvoked = true;
        return new AgentRunner({
          architecture: echoArch, llm,
          tools: new CoreToolExecutor({ tools: [], context: toolContext }),
        });
      },
      toAgentInput: (env) => ({ prompt: (env.payload as { prompt: string }).prompt }),
    });

    await transport.publish({
      id: messageId(), topic: 'schema.requested', type: 'request',
      payload: { prompt: 'hi' }, // missing required `priority`
      metadata: {
        traceId: 't', spanId: 's', conversationId: 'c',
        tenantId: 'x', timestamp: Date.now(),
      },
    });
    await new Promise(r => setTimeout(r, 20));

    expect(runtimeInvoked).toBe(false);
    const rejected = transport.published.find(p => p.topic === 'schema.requested.schema-rejected');
    expect(rejected).toBeDefined();
    expect((rejected?.payload as { error: string }).error).toMatch(/priority/);
    expect(transport.published.find(p => p.topic === 'schema.completed')).toBeUndefined();
    expect(transport.published.find(p => p.topic === 'schema.requested.failed')).toBeUndefined();
    await running.shutdown();
  });

  it('schema validation: valid input flows through normally', async () => {
    const transport = new InlineTransport();
    const card: AgentCard = {
      name: 'schema-agent-valid',
      version: '0.1.0',
      description: '',
      capabilities: [],
      subscribes: ['schema2.requested'],
      publishes: ['schema2.completed'],
      tools: [],
      architecture: 'echo',
      inputSchema: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
      },
    };

    const llm = new MockLLMProvider([{ text: 'processed' }]);
    const running = await bootstrapAgent({
      card,
      contextLoader: inlineLoader,
      transport,
      createRuntime: ({ context }) => new AgentRunner({
        architecture: echoArch, llm,
        tools: new CoreToolExecutor({
          tools: [],
          context: {
            tenantId: context.tenantId,
            workdir: context.runtime.workdir,
            secrets: { get: async () => undefined },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
          },
        }),
      }),
      toAgentInput: (env) => ({ prompt: (env.payload as { prompt: string }).prompt }),
    });

    await transport.publish({
      id: messageId(), topic: 'schema2.requested', type: 'request',
      payload: { prompt: 'valid' },
      metadata: {
        traceId: 't', spanId: 's', conversationId: 'c',
        tenantId: 'x', timestamp: Date.now(),
      },
    });
    await new Promise(r => setTimeout(r, 20));

    const completed = transport.published.find(p => p.topic === 'schema2.completed');
    expect(completed).toBeDefined();
    expect((completed?.payload as { content: string }).content).toBe('processed');
    await running.shutdown();
  });

  it('does not warn on failure topics even if not declared in card.publishes', async () => {
    const transport = new InlineTransport();
    const warnings: string[] = [];
    const card: AgentCard = {
      name: 'failing-strict-agent',
      version: '0.1.0',
      description: '',
      capabilities: [],
      subscribes: ['fail-strict.requested'],
      publishes: ['fail-strict.completed'],
      tools: [],
      architecture: 'echo',
    };

    const broken: ContextLoader = {
      async load(): Promise<AgentContext> { throw new Error('boom'); },
    };

    const llm = new MockLLMProvider([]);
    const running = await bootstrapAgent({
      card,
      contextLoader: broken,
      transport,
      createRuntime: () => new AgentRunner({
        architecture: echoArch, llm,
        tools: new CoreToolExecutor({ tools: [], context: toolContext }),
      }),
      toAgentInput: () => ({ prompt: 'x' }),
      logger: {
        info: () => {},
        warn: (msg: string) => { warnings.push(msg); },
        error: () => {},
        debug: () => {},
      },
    });

    await transport.publish({
      id: messageId(),
      topic: 'fail-strict.requested',
      type: 'request',
      payload: {},
      metadata: {
        traceId: 't', spanId: 's', conversationId: 'c',
        tenantId: 'x', timestamp: Date.now(),
      },
    });
    await new Promise(r => setTimeout(r, 20));

    // The failed topic is `fail-strict.requested.failed` which is NOT in
    // card.publishes — but the lint exempts .failed topics.
    const publishWarning = warnings.find(w => w.includes('fail-strict.requested.failed'));
    expect(publishWarning).toBeUndefined();
    await running.shutdown();
  });
});
