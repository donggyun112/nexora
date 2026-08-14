import { describe, it, expect } from 'vitest';
import {
  HandraiseInbox,
  InMemoryApprovalPolicyStore,
  createApprovalGate,
  createEscalationGuard,
  isApprovalRequest,
  defaultShellHardlineRule,
} from '../index.js';
import type {
  ApprovalGateOptions,
  ApprovalReply,
  ApprovalMode,
  ToolDefinition,
  ToolContext,
  ToolLogger,
} from '../index.js';
import type {
  EventTransport,
  MessageEnvelope,
  RequestOptions,
  ResumeAnswer,
  Subscription,
  ToolDecision,
  ToolGateInfo,
  TopicString,
  TransportDescription,
  WorkspaceSession,
} from '@dongkseo/contracts';
import { matchTopic, messageId, suspendEnvelope, textResult } from '@dongkseo/contracts';

class FakeTransport implements EventTransport {
  private readonly subs = new Map<number, { pattern: string; handler: (e: MessageEnvelope) => Promise<void> }>();
  private nextId = 0;
  public readonly published: MessageEnvelope[] = [];
  /** The whole point of the suspension rewrite: this must stay 0. */
  public requestCalls = 0;

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
    this.requestCalls += 1;
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

interface LogLine {
  event: string;
  data?: unknown;
}

function recordingLogger(sink: LogLine[]): ToolLogger {
  const push = (event: string, data?: unknown) => { sink.push({ event, data }); };
  return { info: push, warn: push, error: push };
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

function makeTool(name: string, groups?: readonly string[]): ToolDefinition {
  return {
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
    ...(groups ? { policyGroups: groups } : {}),
    execute: async () => textResult(`${name} ran`),
  };
}

/** The call a gate stage is handed — `{callId, name, input}` plus context. */
function callInfo(
  name: string,
  input: unknown = {},
  ctx: ToolContext = makeCtx(),
  callId = 'c1',
): ToolGateInfo {
  return { call: { callId, name, input }, context: ctx };
}

function resumeInfo(
  info: ToolGateInfo,
  answer: unknown,
  pendingId = 'pending-1',
): ToolGateInfo & { resume: ResumeAnswer } {
  return { ...info, resume: { pendingId, answer } };
}

const APPROVED_ONCE: ApprovalReply = { choice: 'once', userId: 'u1', displayName: 'Alice' };

function expectDeny(decision: ToolDecision): string {
  expect(decision.kind).toBe('deny');
  if (decision.kind !== 'deny') throw new Error('not a deny');
  expect(decision.result.type).toBe('error');
  return decision.result.type === 'error' ? decision.result.message : '';
}

function questions(transport: FakeTransport, channel = 'default'): MessageEnvelope[] {
  return transport.published.filter((e) => e.topic === `handraise.human.${channel}`);
}

/**
 * The gate never publishes any more, so a test that wants to see the question on
 * the wire has to do what the runtime does: mint the pendingId, publish under
 * it, and only then treat the turn as parked.
 */
async function publishAsRuntimeWould(
  transport: FakeTransport,
  decision: ToolDecision,
  tenantId = 'tenant-A',
): Promise<string> {
  if (decision.kind !== 'suspend') throw new Error('expected suspend');
  const pendingId = messageId();
  await transport.publish(suspendEnvelope(pendingId, decision.request, tenantId));
  return pendingId;
}

/** Gate over a single tool named 'risky', gated by the default predicate. */
function setupGate(opts: {
  transport: FakeTransport;
  store: InMemoryApprovalPolicyStore;
  sessionKey?: string;
  mode?: ApprovalMode;
  resolveMode?: ApprovalGateOptions['resolveMode'];
  hardline?: ApprovalGateOptions['hardline'];
  predicate?: ApprovalGateOptions['predicate'];
}) {
  return createApprovalGate({
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

/** Gate over a policy-group-declaring tool, on the 'multica' channel. */
function setupGroupGate(
  opts: Pick<ApprovalGateOptions, 'resolveGroupAction' | 'mode' | 'predicate' | 'resolveTool'>,
  tool: ToolDefinition,
  transport = new FakeTransport(),
  store = new InMemoryApprovalPolicyStore(),
) {
  const gate = createApprovalGate({
    store,
    channel: 'multica',
    resolveSessionKey: () => 'session-1',
    resolveTool: (name) => (name === tool.name ? tool : undefined),
    ...opts,
  });
  return { gate, transport, store };
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

/**
 * preToolUse decision order. Each step of the documented order gets its own
 * test, including the ones that only matter because of where they sit
 * (hardline before everything, cached deny before mode).
 */
describe('createApprovalGate — preToolUse decision order', () => {
  it('step 1: hardline floor beats mode off, a cached allow, and a skipping predicate', async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    await store.rememberAlways('tenant-A', 'shell-key');
    const logs: LogLine[] = [];
    const { preToolUse } = setupGate({
      transport,
      store,
      mode: 'off',
      hardline: defaultShellHardlineRule,
      predicate: () => null, // predicate would skip approval — hardline must still fire
    });

    const decision = await preToolUse(
      callInfo('shell', { command: 'rm -rf /' }, makeCtx({ logger: recordingLogger(logs) })),
    );

    const message = expectDeny(decision);
    expect(message).toContain('hardline');
    expect(message).toContain('rm_root');
    expect(message).toContain('do not retry');
    expect(logs.map((l) => l.event)).toContain('approval.hardline.block');
    expect(questions(transport)).toHaveLength(0);
  });

  it('hardline floor lets safe commands pass through', async () => {
    const transport = new FakeTransport();
    const { preToolUse } = setupGate({
      transport,
      store: new InMemoryApprovalPolicyStore(),
      mode: 'off',
      hardline: defaultShellHardlineRule,
      predicate: () => null,
    });

    const decision = await preToolUse(callInfo('shell', { command: 'ls /tmp' }));

    expect(decision.kind).toBe('continue');
  });

  it('step 2: policy group deny short-circuits without prompting', async () => {
    const tool = makeTool('outline_get_document');
    tool.permissionGroups = ['outline.collection.out_of_scope'];
    const logs: LogLine[] = [];
    const { gate, transport } = setupGroupGate({
      resolveGroupAction: ({ policyGroup }) =>
        policyGroup === 'outline.collection.out_of_scope'
          ? { action: 'deny', reason: 'collection not allowed' }
          : null,
    }, tool);

    const decision = await gate.preToolUse(
      callInfo(tool.name, { id: 'x' }, makeCtx({ logger: recordingLogger(logs) })),
    );

    expect(expectDeny(decision)).toContain('DENIED');
    expect(logs.map((l) => l.event)).toContain('approval.policy_group.deny');
    expect(transport.published).toHaveLength(0);
  });

  it('step 2: policy group block short-circuits without prompting', async () => {
    const tool = makeTool('deploy_production', ['release.freeze']);
    const { gate, transport } = setupGroupGate({
      resolveGroupAction: ({ policyGroup }) =>
        policyGroup === 'release.freeze' ? { action: 'block', reason: 'release freeze' } : null,
    }, tool);

    const decision = await gate.preToolUse(callInfo(tool.name));

    expect(expectDeny(decision)).toContain('BLOCKED');
    expect(transport.published).toHaveLength(0);
  });

  it('policy group skip leaves the call to the predicate', async () => {
    const tool = makeTool('outline_create_document', ['outline.write', 'requires_review']);
    const { gate, transport } = setupGroupGate({
      resolveGroupAction: ({ policyGroup }) => (policyGroup === 'requires_review' ? 'skip' : null),
    }, tool);

    const decision = await gate.preToolUse(callInfo(tool.name, { title: 'doc' }));

    expect(decision.kind).toBe('continue');
    expect(transport.published).toHaveLength(0);
  });

  it('policy group ask builds the spec and takes the normal ask path', async () => {
    const tool = makeTool('outline_create_document', ['requires_review']);
    const { gate, transport } = setupGroupGate({
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
    }, tool);

    const decision = await gate.preToolUse(callInfo(tool.name, { title: 'doc' }));

    if (decision.kind !== 'suspend') throw new Error('expected suspend');
    expect(transport.published).toHaveLength(0);
    expect(decision.request.topic).toBe('handraise.human.multica');
    const payload = decision.request.payload as { context?: unknown };
    expect(isApprovalRequest(payload.context)).toBe(true);
    if (isApprovalRequest(payload.context)) {
      expect(payload.context.approvalKey).toBe('outline-review');
      expect(payload.context.review).toBe('preview body');
      expect(payload.context.choices).toEqual(['once', 'deny']);
    }
  });

  it('threads context.workspace through to the policy-group resolver', async () => {
    const tool = makeTool('outline_create_document', ['requires_review']);
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
    const { gate } = setupGroupGate({
      resolveGroupAction: (ctx) => {
        receivedWorkspace = ctx.workspace;
        return 'skip';
      },
    }, tool);

    await gate.preToolUse(
      callInfo(tool.name, { title: 'doc' }, makeCtx({ workspace: stubWorkspace })),
    );

    expect(receivedWorkspace).toBe(stubWorkspace);
  });

  it('denies when group policy is configured but the tool cannot be resolved', async () => {
    // "no tool found" must not read as "declares no groups" — that would let a
    // lookup miss walk straight past an escalation guard.
    const tool = makeTool('privileged_op', ['B']);
    const { gate } = setupGroupGate({
      resolveGroupAction: createEscalationGuard(['A']),
      resolveTool: () => undefined,
    }, tool);

    const decision = await gate.preToolUse(callInfo(tool.name));

    expect(expectDeny(decision)).toContain('could not resolve tool');
  });

  it('denies a delegated tool whose group escalates beyond inherited authority', async () => {
    const tool = makeTool('privileged_op');
    tool.permissionGroups = ['B'];
    const { gate, transport } = setupGroupGate({
      resolveGroupAction: createEscalationGuard(['A']),
    }, tool);

    const decision = await gate.preToolUse(callInfo(tool.name));

    expect(expectDeny(decision)).toContain('DENIED');
    expect(transport.published).toHaveLength(0);
  });

  it('allows a delegated tool whose group is within inherited authority', async () => {
    const tool = makeTool('granted_op');
    tool.permissionGroups = ['A'];
    const { gate } = setupGroupGate({
      resolveGroupAction: createEscalationGuard(['A']),
    }, tool);

    expect((await gate.preToolUse(callInfo(tool.name))).kind).toBe('continue');
  });

  it('step 3: a call with no spec continues without a prompt', async () => {
    const transport = new FakeTransport();
    const { preToolUse } = setupGate({ transport, store: new InMemoryApprovalPolicyStore() });

    const decision = await preToolUse(callInfo('safe', { x: 1 }));

    expect(decision.kind).toBe('continue');
    expect(transport.published).toHaveLength(0);
  });

  it("step 5: a cached deny binds even under mode='off'", async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    await store.rememberDeny('tenant-A', 'session-1', 'risky-key', 'Carol');
    const logs: LogLine[] = [];
    const { preToolUse } = setupGate({ transport, store, mode: 'off' });

    const decision = await preToolUse(
      callInfo('risky', {}, makeCtx({ logger: recordingLogger(logs) })),
    );

    expect(expectDeny(decision)).toContain('prior policy');
    expect(logs.map((l) => l.event)).toContain('approval.cached.deny');
  });

  it("step 6: mode='block' denies without prompting", async () => {
    const transport = new FakeTransport();
    const logs: LogLine[] = [];
    const { preToolUse } = setupGate({
      transport,
      store: new InMemoryApprovalPolicyStore(),
      mode: 'block',
    });

    const decision = await preToolUse(
      callInfo('risky', {}, makeCtx({ logger: recordingLogger(logs) })),
    );

    expect(expectDeny(decision)).toContain("mode='block'");
    expect(logs.map((l) => l.event)).toContain('approval.mode.block');
    expect(questions(transport)).toHaveLength(0);
  });

  it("step 7: mode='off' continues without prompting", async () => {
    const transport = new FakeTransport();
    const logs: LogLine[] = [];
    const { preToolUse } = setupGate({
      transport,
      store: new InMemoryApprovalPolicyStore(),
      mode: 'off',
    });

    const decision = await preToolUse(
      callInfo('risky', {}, makeCtx({ logger: recordingLogger(logs) })),
    );

    expect(decision.kind).toBe('continue');
    expect(logs.map((l) => l.event)).toContain('approval.mode.off');
    expect(transport.published).toHaveLength(0);
  });

  it('step 8: a cached allow continues without prompting', async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    await store.rememberSession('tenant-A', 'session-1', 'risky-key', 'session');
    const logs: LogLine[] = [];
    const { preToolUse } = setupGate({ transport, store });

    const decision = await preToolUse(
      callInfo('risky', {}, makeCtx({ logger: recordingLogger(logs) })),
    );

    expect(decision.kind).toBe('continue');
    expect(logs.map((l) => l.event)).toContain('approval.cached.allow');
    expect(questions(transport)).toHaveLength(0);
  });

  it('resolveMode overrides the static mode per call', async () => {
    const transport = new FakeTransport();
    const { preToolUse } = setupGate({
      transport,
      store: new InMemoryApprovalPolicyStore(),
      mode: 'ask',
      resolveMode: () => 'off',
    });

    expect((await preToolUse(callInfo('risky'))).kind).toBe('continue');
    expect(transport.published).toHaveLength(0);
  });

  it('step 9: asks by RETURNING the question — it publishes nothing at all', async () => {
    const transport = new FakeTransport();
    const logs: LogLine[] = [];
    const { preToolUse } = setupGate({ transport, store: new InMemoryApprovalPolicyStore() });

    const decision = await preToolUse(
      callInfo('risky', { x: 1 }, makeCtx({ logger: recordingLogger(logs) })),
    );

    expect(decision.kind).toBe('suspend');
    // The whole point: deciding is pure. Publishing is the runtime's job, and it
    // happens only after the park is recorded — so re-running this stage during
    // recovery cannot put a second question on the wire.
    expect(transport.published).toHaveLength(0);
    // The old gate blocked here on a wall-clock deadline. It must not any more.
    expect(transport.requestCalls).toBe(0);
    expect(logs.map((l) => l.event)).toContain('approval.request');
  });

  it('step 9: the returned request carries the topic and the approval payload', async () => {
    const transport = new FakeTransport();
    const { preToolUse } = createApprovalGate({
      store: new InMemoryApprovalPolicyStore(),
      predicate: () => ({ approvalKey: 'risky-key', command: 'rm -rf /tmp/x', reason: 'cleanup' }),
      resolveSessionKey: () => 'session-1',
      resolveRoute: () => ({ channelId: 'chan-9', threadId: 'thread-9' }),
    });

    const decision = await preToolUse(callInfo('risky', {}, makeCtx(), 'call-77'));

    if (decision.kind !== 'suspend') throw new Error('expected suspend');
    expect(decision.request.topic).toBe('handraise.human.default');
    const payload = decision.request.payload as {
      question: string;
      callId: string;
      pendingId?: string;
      context?: unknown;
    };
    expect(payload.question).toBe('Approve: rm -rf /tmp/x');
    expect(payload.callId).toBe('call-77');
    // The gate does not mint the correlation id — the runtime does.
    expect(payload.pendingId).toBeUndefined();
    expect(isApprovalRequest(payload.context)).toBe(true);
    if (isApprovalRequest(payload.context)) {
      expect(payload.context.sessionKey).toBe('session-1');
      expect(payload.context.channelId).toBe('chan-9');
      expect(payload.context.threadId).toBe('thread-9');
    }

    // And once the runtime publishes it, the wire format is what it always was:
    // envelope id == pendingId, because a reply correlates by replyTo.
    const pendingId = await publishAsRuntimeWould(transport, decision);
    const asked = questions(transport);
    expect(asked).toHaveLength(1);
    expect(asked[0].id).toBe(pendingId);
    expect(asked[0].metadata.tenantId).toBe('tenant-A');
    expect((asked[0].payload as { pendingId?: string }).pendingId).toBe(pendingId);
  });
});

/** Steps 10-11: applying the answer. */
describe('createApprovalGate — onResume', () => {
  it("step 10 'once': continues and caches nothing", async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    const { onResume } = setupGate({ transport, store });

    const decision = await onResume(resumeInfo(callInfo('risky'), APPROVED_ONCE));

    expect(decision.kind).toBe('continue');
    expect(await store.lookup('tenant-A', 'session-1', 'risky-key')).toBe('unknown');
  });

  it("step 10 'session': caches for this session only, and the next call stops asking", async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    const gate = setupGate({ transport, store });
    const reply: ApprovalReply = { choice: 'session', displayName: 'Alice' };

    expect((await gate.onResume(resumeInfo(callInfo('risky'), reply))).kind).toBe('continue');
    expect(await store.lookup('tenant-A', 'session-1', 'risky-key')).toBe('allow');
    expect(await store.lookup('tenant-A', 'session-2', 'risky-key')).toBe('unknown');

    const second = await gate.preToolUse(callInfo('risky', {}, makeCtx(), 'c2'));
    expect(second.kind).toBe('continue');
    expect(questions(transport)).toHaveLength(0);
  });

  it("step 10 'always': caches for the tenant across sessions", async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    const first = setupGate({ transport, store, sessionKey: 'session-1' });
    const reply: ApprovalReply = { choice: 'always', displayName: 'Alice' };

    await first.onResume(resumeInfo(callInfo('risky'), reply));

    const other = setupGate({ transport, store, sessionKey: 'session-2' });
    expect((await other.preToolUse(callInfo('risky'))).kind).toBe('continue');
    expect(questions(transport)).toHaveLength(0);
  });

  it("step 10 'deny': denies and remembers a session-scope deny", async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    const gate = setupGate({ transport, store });
    const reply: ApprovalReply = { choice: 'deny', displayName: 'Alice' };

    const decision = await gate.onResume(resumeInfo(callInfo('risky'), reply));

    expect(expectDeny(decision)).toContain('Approval denied by Alice');
    expect(await store.lookup('tenant-A', 'session-1', 'risky-key')).toBe('deny');
    // And the deny now binds the next call without a new question.
    const second = await gate.preToolUse(callInfo('risky', {}, makeCtx(), 'c2'));
    expect(expectDeny(second)).toContain('prior policy');
    expect(questions(transport)).toHaveLength(0);
  });

  it('denies an answer that carries no choice', async () => {
    const { onResume } = setupGate({
      transport: new FakeTransport(),
      store: new InMemoryApprovalPolicyStore(),
    });

    const decision = await onResume(resumeInfo(callInfo('risky'), { userId: 'u1' }));

    expect(expectDeny(decision)).toContain('missing a choice');
  });

  it('step 11: the audit trail is the approval.granted log (choice + decidedBy)', async () => {
    const logs: LogLine[] = [];
    const { onResume } = setupGate({
      transport: new FakeTransport(),
      store: new InMemoryApprovalPolicyStore(),
    });

    await onResume(
      resumeInfo(callInfo('risky', {}, makeCtx({ logger: recordingLogger(logs) })), APPROVED_ONCE),
    );

    const granted = logs.find((l) => l.event === 'approval.granted');
    expect(granted?.data).toMatchObject({ tool: 'risky', choice: 'once', decidedBy: 'Alice' });
  });

  it('step 11: the same two facts ride back on the continue as audit', async () => {
    const { onResume } = setupGate({
      transport: new FakeTransport(),
      store: new InMemoryApprovalPolicyStore(),
    });

    const decision = await onResume(resumeInfo(callInfo('risky'), APPROVED_ONCE));

    // Only the gate knows these; the loop sees `continue` and nothing else.
    // Carrying them here is what puts them back into the transcript, which the
    // old `[approved-<choice> by <who>]` result footer used to do.
    expect(decision).toEqual({
      kind: 'continue',
      audit: { choice: 'once', decidedBy: 'Alice' },
    });
  });

  it('omits decidedBy when the reply named nobody', async () => {
    const { onResume } = setupGate({
      transport: new FakeTransport(),
      store: new InMemoryApprovalPolicyStore(),
    });

    const decision = await onResume(resumeInfo(callInfo('risky'), { choice: 'once' }));

    expect(decision).toEqual({ kind: 'continue', audit: { choice: 'once' } });
  });

  it('a cached allow is recorded too — it is an earlier human approval', async () => {
    const store = new InMemoryApprovalPolicyStore();
    await store.rememberSession('tenant-A', 'session-1', 'risky-key', 'session');
    const { preToolUse } = setupGate({ transport: new FakeTransport(), store });

    const decision = await preToolUse(callInfo('risky'));

    expect(decision).toEqual({
      kind: 'continue',
      audit: { cached: 'allow', approvalKey: 'risky-key' },
    });
  });

  it("an ungated call and mode 'off' stay silent — no human is behind either", async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
    // step 3: the predicate declines to gate this call at all.
    expect(await setupGate({ transport, store }).preToolUse(callInfo('safe'))).toEqual({
      kind: 'continue',
    });
    // step 7: gated, but enforcement is off.
    expect(
      await setupGate({ transport, store, mode: 'off' }).preToolUse(callInfo('risky')),
    ).toEqual({ kind: 'continue' });
  });
});

/**
 * Blocking applied the decision the instant it was made, so policy could not
 * move underneath it. Parking opens that window, so onResume re-runs steps 1-8
 * before the answer counts.
 */
describe('createApprovalGate — revalidation while parked', () => {
  it('a hardline rule added while parked overturns a human approval', async () => {
    let hardlineActive = false;
    const { preToolUse, onResume } = setupGate({
      transport: new FakeTransport(),
      store: new InMemoryApprovalPolicyStore(),
      hardline: (name, input) => (hardlineActive ? defaultShellHardlineRule(name, input) : null),
      predicate: () => ({ approvalKey: 'shell-key', command: 'rm -rf /', reason: 'cleanup' }),
    });
    const info = callInfo('shell', { command: 'rm -rf /' });
    expect((await preToolUse(info)).kind).toBe('suspend');

    hardlineActive = true;
    const decision = await onResume(resumeInfo(info, APPROVED_ONCE));

    expect(expectDeny(decision)).toContain('hardline');
  });

  it('a policy group flipped to deny while parked overturns a human approval', async () => {
    const tool = makeTool('outline_create_document', ['requires_review']);
    let action: 'ask' | 'deny' = 'ask';
    const { gate } = setupGroupGate({
      resolveGroupAction: () =>
        action === 'ask'
          ? { action: 'ask', approvalKey: 'outline-review', command: tool.name, reason: 'review' }
          : { action: 'deny', reason: 'collection revoked' },
    }, tool);
    const info = callInfo(tool.name, { title: 'doc' });
    expect((await gate.preToolUse(info)).kind).toBe('suspend');

    action = 'deny';
    const decision = await gate.onResume(resumeInfo(info, APPROVED_ONCE));

    expect(expectDeny(decision)).toContain('DENIED');
  });

  it('a deny cached while parked overturns a human approval', async () => {
    const store = new InMemoryApprovalPolicyStore();
    const { preToolUse, onResume } = setupGate({ transport: new FakeTransport(), store });
    const info = callInfo('risky');
    expect((await preToolUse(info)).kind).toBe('suspend');

    // Someone else denied the same action while this one sat parked.
    await store.rememberDeny('tenant-A', 'session-1', 'risky-key', 'Dave');
    const decision = await onResume(resumeInfo(info, APPROVED_ONCE));

    expect(expectDeny(decision)).toContain('prior policy');
  });

  it('marks the overturning log line as coming from the resume, not the first gate', async () => {
    const logs: LogLine[] = [];
    const store = new InMemoryApprovalPolicyStore();
    const { preToolUse, onResume } = setupGate({ transport: new FakeTransport(), store });
    const info = callInfo('risky', {}, makeCtx({ logger: recordingLogger(logs) }));
    expect((await preToolUse(info)).kind).toBe('suspend');

    await store.rememberDeny('tenant-A', 'session-1', 'risky-key', 'Dave');
    await onResume(resumeInfo(info, APPROVED_ONCE));

    // The same event name fires from both gates. "A human approved and policy
    // overturned it" is the one an operator has to be able to pick out.
    const denied = logs.filter((l) => l.event === 'approval.cached.deny');
    expect(denied).toHaveLength(1);
    expect((denied[0].data as { source?: string }).source).toBe('on_resume');
  });

  it("mode flipped to 'block' while parked overturns a human approval", async () => {
    let mode: ApprovalMode = 'ask';
    const { preToolUse, onResume } = setupGate({
      transport: new FakeTransport(),
      store: new InMemoryApprovalPolicyStore(),
      resolveMode: () => mode,
    });
    const info = callInfo('risky');
    expect((await preToolUse(info)).kind).toBe('suspend');

    mode = 'block';
    const decision = await onResume(resumeInfo(info, APPROVED_ONCE));

    expect(expectDeny(decision)).toContain("mode='block'");
  });
});

describe('createApprovalGate — HandraiseInbox round trip', () => {
  it('the inbox renders the parked question and its answer correlates by replyTo', async () => {
    const transport = new FakeTransport();
    const store = new InMemoryApprovalPolicyStore();
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

    const { preToolUse, onResume } = setupGate({ transport, store });
    const info = callInfo('risky');
    const decision = await preToolUse(info);
    // The gate only decided; the runtime publishes after recording the park.
    expect(transport.published).toHaveLength(0);
    const pendingId = await publishAsRuntimeWould(transport, decision);

    const answered = transport.published.find(
      (e) => e.topic === 'handraise.human.default.answered',
    );
    expect(answered?.metadata.replyTo).toBe(pendingId);
    expect(transport.requestCalls).toBe(0);

    const payload = answered?.payload as { answer?: unknown };
    const resumed = await onResume(resumeInfo(info, payload?.answer, pendingId));
    expect(resumed.kind).toBe('continue');
    inbox.stop();
  });
});

describe('hardline shell rules', () => {
  it('catches rm flag variants and avoids non-recursive chmod false positives', () => {
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
