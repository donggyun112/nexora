import { describe, it, expect } from 'vitest';
import {
  HandraiseInbox,
  InMemoryApprovalPolicyStore,
  createApprovalGateMiddleware,
  createEscalationGuard,
  isApprovalRequest,
  defaultShellHardlineRule,
} from '../index.js';
import type {
  ApprovalRequest,
  ApprovalReply,
  ApprovalMode,
  ToolDefinition,
  ToolContext,
} from '../index.js';
import type {
  EventTransport,
  MessageEnvelope,
  RequestOptions,
  Subscription,
  TopicString,
  TransportDescription,
  WorkspaceSession,
} from '@dongkseo/contracts';
import { matchTopic, messageId, textResult } from '@dongkseo/contracts';

class FakeTransport implements EventTransport {
  private readonly subs = new Map<number, { pattern: string; handler: (e: MessageEnvelope) => Promise<void> }>();
  private nextId = 0;
  public readonly published: MessageEnvelope[] = [];

  describe(): TransportDescription {
    return { kind: 'fake', deliveryGuarantee: 'at-most-once', durable: false, supportsConsumerGroups: false };
  }
  async publish(env: MessageEnvelope): Promise<void> {
    this.published.push(env);
    const matched = Array.from(this.subs.values()).filter((s) =>
      matchTopic(s.pattern, env.topic as TopicString),
    );
    for (const m of matched) await m.handler(env);
  }
  subscribe(pattern: string, handler: (e: MessageEnvelope) => Promise<void>): Subscription {
    const id = this.nextId++;
    this.subs.set(id, { pattern, handler });
    return { unsubscribe: () => { this.subs.delete(id); } };
  }
  async request(topic: TopicString, payload: unknown, options?: RequestOptions): Promise<MessageEnvelope> {
    const requestId = messageId();
    const timeoutMs = options?.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      let resolved = false;
      const sub = this.subscribe('#', async (incoming) => {
        if (resolved) return;
        if (incoming.metadata.replyTo === requestId) {
          resolved = true;
          sub.unsubscribe();
          clearTimeout(timer);
          resolve(incoming);
        }
      });
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        sub.unsubscribe();
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      void this.publish({
        id: requestId,
        topic,
        type: 'request',
        payload,
        metadata: {
          traceId: 't',
          spanId: 's',
          conversationId: 'c',
          tenantId: options?.tenantId ?? 'default',
          timestamp: Date.now(),
        },
      });
    });
  }
  async close(): Promise<void> { this.subs.clear(); }
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: 'tenant-A',
    workdir: '/tmp',
    secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

function makeTool(name: string, calls: { input: unknown }[]): ToolDefinition {
  return {
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
    execute: async (_id, input) => {
      calls.push({ input });
      return textResult(`${name} ran`);
    },
  };
}

describe('InMemoryApprovalPolicyStore', () => {
  it('returns unknown when nothing has been remembered', async () => {
    const store = new InMemoryApprovalPolicyStore();
    expect(await store.lookup('t', 'sk', 'rm-tmp')).toBe('unknown');
  });
  it('remembers a session allow scoped to the sessionKey', async () => {
    const store = new InMemoryApprovalPolicyStore();
    await store.rememberSession('t', 'sk1', 'rm-tmp', 'session');
    expect(await store.lookup('t', 'sk1', 'rm-tmp')).toBe('allow');
    expect(await store.lookup('t', 'sk2', 'rm-tmp')).toBe('unknown');
  });
  it('remembers always allow across sessions for the same tenant', async () => {
    const store = new InMemoryApprovalPolicyStore();
    await store.rememberAlways('t', 'rm-tmp');
    expect(await store.lookup('t', 'sk1', 'rm-tmp')).toBe('allow');
    expect(await store.lookup('t', 'sk2', 'rm-tmp')).toBe('allow');
  });
  it('keeps tenants isolated', async () => {
    const store = new InMemoryApprovalPolicyStore();
    await store.rememberAlways('tenantA', 'rm-tmp');
    expect(await store.lookup('tenantB', 'sk', 'rm-tmp')).toBe('unknown');
  });
  it('records a tenant-wide deny that survives sessions', async () => {
    const store = new InMemoryApprovalPolicyStore();
    await store.rememberDeny('t', 'sk-irrelevant', 'rm-tmp', undefined, 'always');
    expect(await store.lookup('t', 'other-session', 'rm-tmp')).toBe('deny');
  });
  it('clears all session records for a given sessionKey', async () => {
    const store = new InMemoryApprovalPolicyStore();
    await store.rememberSession('t', 'sk1', 'rm-tmp', 'session');
    await store.clearSession('t', 'sk1');
    expect(await store.lookup('t', 'sk1', 'rm-tmp')).toBe('unknown');
  });
});

describe('approvalGateMiddleware', () => {
  const baseCtx = {
    input: { tenantId: 'tenant-A' } as unknown as Parameters<NonNullable<ToolDefinition['execute']>>[1],
    tools: [] as ToolDefinition[],
    systemPrompt: '',
  };

  function setupGate(opts: {
    transport: FakeTransport;
    store: InMemoryApprovalPolicyStore;
    sessionKey?: string;
    mode?: ApprovalMode;
    resolveMode?: (ctx: { tenantId: string; toolName: string; sessionKey: string }) => ApprovalMode | undefined;
    hardline?: Parameters<typeof createApprovalGateMiddleware>[0]['hardline'];
    predicate?: Parameters<typeof createApprovalGateMiddleware>[0]['predicate'];
  }) {
    return createApprovalGateMiddleware({
      transport: opts.transport,
      store: opts.store,
      channel: 'default',
      predicate:
        opts.predicate ??
        ((tool) =>
          tool === 'risky'
            ? { approvalKey: 'risky-key', command: 'rm -rf /tmp/x', reason: 'cleanup' }
            : null),
      resolveSessionKey: () => opts.sessionKey ?? 'session-1',
      mode: opts.mode,
      resolveMode: opts.resolveMode,
      hardline: opts.hardline,
    });
  }

  function autoRespond(
    transport: FakeTransport,
    choice: 'once' | 'session' | 'always' | 'deny',
    channel = 'default',
  ) {
    // Auto-respond to any handraise request on the selected channel.
    transport.subscribe(`handraise.human.${channel}`, async (env) => {
      const payload = env.payload as { context?: unknown };
      if (!isApprovalRequest(payload.context)) return;
      const reply: ApprovalReply = { choice, userId: 'u1', displayName: 'Alice' };
      await transport.publish({
        id: messageId(),
        topic: `handraise.human.${channel}.answered`,
        type: 'result',
        payload: { answer: reply },
        metadata: {
          ...env.metadata,
          replyTo: env.id,
          timestamp: Date.now(),
        },
      });
    });
  }

  function wrap(mw: ReturnType<typeof setupGate>, tool: ToolDefinition): ToolDefinition {
    const ctx = { tools: [tool], input: baseCtx.input, systemPrompt: '' };
    mw.beforeExecution(ctx);
    return ctx.tools[0];
  }

  function wrapPolicyGroupTool(
    opts: Pick<Parameters<typeof createApprovalGateMiddleware>[0], 'resolveGroupAction' | 'mode' | 'predicate'>,
    tool: ToolDefinition,
    transport = new FakeTransport(),
    store = new InMemoryApprovalPolicyStore(),
  ): { wrapped: ToolDefinition; transport: FakeTransport; store: InMemoryApprovalPolicyStore } {
    const mw = createApprovalGateMiddleware({
      transport,
      store,
      channel: 'multica',
      resolveSessionKey: () => 'session-1',
      ...opts,
    });
    const ctx = { tools: [tool], input: baseCtx.input, systemPrompt: '' };
    mw.beforeExecution(ctx);
    return { wrapped: ctx.tools[0], transport, store };
  }

  it('passes through non-risky tools', async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    const mw = setupGate({ transport, store });
    const calls: { input: unknown }[] = [];
    const wrapped = wrap(mw, makeTool('safe', calls));
    const result = await wrapped.execute('c1', { x: 1 }, makeCtx());
    expect(result.type).toBe('text');
    expect(calls).toHaveLength(1);
    const requests = transport.published.filter((e) => e.topic === 'handraise.human.default');
    expect(requests).toHaveLength(0);
  });

  it('policy group action=skip bypasses the explicit gate for that group', async () => {
    const calls: { input: unknown }[] = [];
    const tool: ToolDefinition = {
      ...makeTool('outline_create_document', calls),
      policyGroups: ['outline.write', 'requires_review'],
    };
    const { wrapped, transport } = wrapPolicyGroupTool({
      resolveGroupAction: ({ policyGroup }) =>
        policyGroup === 'requires_review' ? 'skip' : null,
    }, tool);

    const result = await wrapped.execute('c1', { title: 'doc' }, makeCtx());

    expect(result.type).toBe('text');
    expect(calls).toHaveLength(1);
    expect(transport.published.some((m) => m.type === 'request')).toBe(false);
  });

  it('policy group action=ask uses the normal approval flow', async () => {
    const transport = new FakeTransport();
    autoRespond(transport, 'once', 'multica');
    const calls: { input: unknown }[] = [];
    const tool: ToolDefinition = {
      ...makeTool('outline_create_document', calls),
      policyGroups: ['requires_review'],
    };
    const { wrapped } = wrapPolicyGroupTool({
      resolveGroupAction: ({ policyGroup, channel }) =>
        policyGroup === 'requires_review' && channel === 'multica'
          ? {
              action: 'ask',
              approvalKey: 'outline-review',
              command: 'outline_create_document',
              reason: 'Outline write review',
              choices: ['once', 'deny'] as const,
              review: 'preview body',
            }
          : 'skip',
    }, tool, transport);

    const result = await wrapped.execute('c1', { title: 'doc' }, makeCtx());

    expect(result.type).toBe('text');
    expect(calls).toHaveLength(1);
    const requests = transport.published.filter((e) => e.topic === 'handraise.human.multica');
    expect(requests).toHaveLength(1);
    const payload = requests[0].payload as { context?: unknown };
    expect(isApprovalRequest(payload.context)).toBe(true);
    if (isApprovalRequest(payload.context)) {
      expect(payload.context.approvalKey).toBe('outline-review');
      expect(payload.context.review).toBe('preview body');
    }
  });

  it('threads toolCtx.workspace through to the policy-group resolver', async () => {
    const calls: { input: unknown }[] = [];
    const tool: ToolDefinition = {
      ...makeTool('outline_create_document', calls),
      policyGroups: ['requires_review'],
    };
    const stubWorkspace = {
      id: 'ws-1',
      root: '/workspace',
      mode: 'workspace-write',
      mounts: [],
      resolve: async () => {
        throw new Error('not implemented in stub');
      },
      cleanup: async () => {},
    } as unknown as WorkspaceSession;
    let receivedWorkspace: WorkspaceSession | undefined;
    const { wrapped } = wrapPolicyGroupTool({
      resolveGroupAction: (ctx) => {
        receivedWorkspace = ctx.workspace;
        return 'skip';
      },
    }, tool);

    await wrapped.execute('c1', { title: 'doc' }, makeCtx({ workspace: stubWorkspace }));

    expect(receivedWorkspace).toBe(stubWorkspace);
  });

  it('policy group action=block short-circuits without prompting', async () => {
    const calls: { input: unknown }[] = [];
    const tool: ToolDefinition = {
      ...makeTool('deploy_production', calls),
      policyGroups: ['release.freeze'],
    };
    const { wrapped, transport } = wrapPolicyGroupTool({
      resolveGroupAction: ({ policyGroup }) =>
        policyGroup === 'release.freeze'
          ? { action: 'block', reason: 'release freeze' }
          : null,
    }, tool);

    const result = await wrapped.execute('c1', {}, makeCtx());

    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toContain('BLOCKED');
    expect(calls).toHaveLength(0);
    expect(transport.published.some((m) => m.type === 'request')).toBe(false);
  });

  it('policy group action=deny hard-denies without prompting', async () => {
    const calls: { input: unknown }[] = [];
    const tool: ToolDefinition = {
      ...makeTool('outline_get_document', calls),
      permissionGroups: ['outline.collection.out_of_scope'],
    };
    const { wrapped, transport } = wrapPolicyGroupTool({
      resolveGroupAction: ({ policyGroup }) =>
        policyGroup === 'outline.collection.out_of_scope'
          ? { action: 'deny', reason: 'collection not allowed' }
          : null,
    }, tool);

    const result = await wrapped.execute('c1', { id: 'x' }, makeCtx());

    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toContain('DENIED');
    expect(calls).toHaveLength(0);
    expect(transport.published.some((m) => m.type === 'request')).toBe(false);
  });

  it('denies a delegated tool whose group escalates beyond inherited authority', async () => {
    const calls: { input: unknown }[] = [];
    // Parent was granted only {A}; a delegatee tool declaring group B is escalation.
    const escalating: ToolDefinition = {
      ...makeTool('privileged_op', calls),
      permissionGroups: ['B'],
    };
    const { wrapped, transport } = wrapPolicyGroupTool({
      resolveGroupAction: createEscalationGuard(['A']),
    }, escalating);

    const result = await wrapped.execute('c1', {}, makeCtx());

    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toContain('DENIED');
    expect(calls).toHaveLength(0);
    expect(transport.published.some((m) => m.type === 'request')).toBe(false);
  });

  it('allows a delegated tool whose group is within inherited authority', async () => {
    const calls: { input: unknown }[] = [];
    const inScope: ToolDefinition = {
      ...makeTool('granted_op', calls),
      permissionGroups: ['A'],
    };
    const { wrapped } = wrapPolicyGroupTool({
      resolveGroupAction: createEscalationGuard(['A']),
    }, inScope);

    const result = await wrapped.execute('c1', {}, makeCtx());

    expect(result.type).toBe('text');
    expect(calls).toHaveLength(1);
  });

  it('grants once: runs tool, does not cache', async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    autoRespond(transport, 'once');
    const mw = setupGate({ transport, store });
    const calls: { input: unknown }[] = [];
    const wrapped = wrap(mw, makeTool('risky', calls));

    await wrapped.execute('c1', {}, makeCtx());
    expect(calls).toHaveLength(1);
    expect(await store.lookup('tenant-A', 'session-1', 'risky-key')).toBe('unknown');
    const requests = transport.published.filter((e) => e.topic === 'handraise.human.default');
    expect(requests).toHaveLength(1);
  });

  it('grants session: caches for this session, bypasses prompt on second call', async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    autoRespond(transport, 'session');
    const mw = setupGate({ transport, store });
    const calls: { input: unknown }[] = [];
    const wrapped = wrap(mw, makeTool('risky', calls));

    await wrapped.execute('c1', {}, makeCtx());
    await wrapped.execute('c2', {}, makeCtx());
    expect(calls).toHaveLength(2);
    const requests = transport.published.filter((e) => e.topic === 'handraise.human.default');
    expect(requests).toHaveLength(1);
  });

  it('grants always: persists across sessions', async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    autoRespond(transport, 'always');
    const mw1 = setupGate({ transport, store, sessionKey: 'session-1' });
    const calls: { input: unknown }[] = [];
    const wrapped1 = wrap(mw1, makeTool('risky', calls));
    await wrapped1.execute('c1', {}, makeCtx());

    const mw2 = setupGate({ transport, store, sessionKey: 'session-2' });
    const wrapped2 = wrap(mw2, makeTool('risky', calls));
    await wrapped2.execute('c2', {}, makeCtx());

    expect(calls).toHaveLength(2);
    const requests = transport.published.filter((e) => e.topic === 'handraise.human.default');
    expect(requests).toHaveLength(1);
  });

  it('denies: returns errorResult and remembers session-scope deny', async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    autoRespond(transport, 'deny');
    const mw = setupGate({ transport, store });
    const calls: { input: unknown }[] = [];
    const wrapped = wrap(mw, makeTool('risky', calls));

    const result = await wrapped.execute('c1', {}, makeCtx());
    expect(result.type).toBe('error');
    expect(calls).toHaveLength(0);
    expect(await store.lookup('tenant-A', 'session-1', 'risky-key')).toBe('deny');

    const result2 = await wrapped.execute('c2', {}, makeCtx());
    expect(result2.type).toBe('error');
    const requests = transport.published.filter((e) => e.topic === 'handraise.human.default');
    expect(requests).toHaveLength(1);
  });

  it('uses end-to-end inbox round-trip when wired together', async () => {
    const transport = new FakeTransport();
    const inbox = new HandraiseInbox({
      transport,
      channels: ['default'],
      onPending: async (entry) => {
        const reqCtx = (entry.envelope.payload as { context?: unknown }).context;
        expect(isApprovalRequest(reqCtx)).toBe(true);
        const reply: ApprovalReply = { choice: 'once', userId: 'u-9', displayName: 'Bob' };
        await inbox.answer(entry.id, reply);
      },
    });
    inbox.start();

    const store = new InMemoryApprovalPolicyStore();
    const mw = setupGate({ transport, store });
    const calls: { input: unknown }[] = [];
    const wrapped = wrap(mw, makeTool('risky', calls));

    const result = await wrapped.execute('c1', {}, makeCtx());
    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('[approved-once by Bob]');
    inbox.stop();
  });

  it("mode='off': skips prompt and runs the tool", async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    const mw = setupGate({ transport, store, mode: 'off' });
    const calls: { input: unknown }[] = [];
    const wrapped = wrap(mw, makeTool('risky', calls));

    const result = await wrapped.execute('c1', { x: 1 }, makeCtx());
    expect(result.type).toBe('text');
    expect(calls).toHaveLength(1);
    // No prompt was published.
    expect(transport.published.some((m) => m.type === 'request')).toBe(false);
  });

  it("mode='off': prior 'deny' record still binds", async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    await store.rememberDeny('tenant-A', 'session-1', 'risky-key', 'Carol');
    const mw = setupGate({ transport, store, mode: 'off' });
    const calls: { input: unknown }[] = [];
    const wrapped = wrap(mw, makeTool('risky', calls));

    const result = await wrapped.execute('c1', {}, makeCtx());
    expect(result.type).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it("mode='block': short-circuits without prompting", async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    const mw = setupGate({ transport, store, mode: 'block' });
    const calls: { input: unknown }[] = [];
    const wrapped = wrap(mw, makeTool('risky', calls));

    const result = await wrapped.execute('c1', {}, makeCtx());
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toContain("mode='block'");
    expect(calls).toHaveLength(0);
    expect(transport.published.some((m) => m.type === 'request')).toBe(false);
  });

  it("resolveMode overrides static mode per call", async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    const mw = setupGate({
      transport,
      store,
      mode: 'ask',
      resolveMode: () => 'off',
    });
    const calls: { input: unknown }[] = [];
    const wrapped = wrap(mw, makeTool('risky', calls));

    const result = await wrapped.execute('c1', {}, makeCtx());
    expect(result.type).toBe('text');
    expect(calls).toHaveLength(1);
  });

  it('hardline floor blocks even when mode=off', async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    const mw = setupGate({
      transport,
      store,
      mode: 'off',
      hardline: defaultShellHardlineRule,
      predicate: () => null, // predicate would skip approval — hardline must still fire
    });
    const calls: { input: unknown }[] = [];
    const wrapped = wrap(mw, makeTool('shell', calls));

    const result = await wrapped.execute('c1', { command: 'rm -rf /' }, makeCtx());
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.message).toContain('hardline');
      expect(result.message).toContain('rm_root');
    }
    expect(calls).toHaveLength(0);
  });

  it('hardline floor lets safe commands pass through', async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    const mw = setupGate({
      transport,
      store,
      mode: 'off',
      hardline: defaultShellHardlineRule,
      predicate: () => null,
    });
    const calls: { input: unknown }[] = [];
    const wrapped = wrap(mw, makeTool('shell', calls));

    const result = await wrapped.execute('c1', { command: 'ls /tmp' }, makeCtx());
    expect(result.type).toBe('text');
    expect(calls).toHaveLength(1);
  });

  it('hardline shell rules catch rm flag variants and avoid non-recursive chmod false positives', () => {
    expect(defaultShellHardlineRule('shell', { command: 'rm -f -r /Users' })?.ruleId)
      .toBe('hardline.rm_root');
    expect(defaultShellHardlineRule('shell', { command: 'rm -rf --no-preserve-root /' })?.ruleId)
      .toBe('hardline.rm_root');
    expect(defaultShellHardlineRule('shell', { command: 'chmod 644 /etc/hosts' }))
      .toBeNull();
    expect(defaultShellHardlineRule('shell', { command: 'chmod -R 755 /etc' })?.ruleId)
      .toBe('hardline.chmod_root');
  });
});
