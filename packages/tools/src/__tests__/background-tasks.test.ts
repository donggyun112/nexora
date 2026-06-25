import { describe, it, expect, vi } from 'vitest';
import { createDelegateTool } from '../builtin/delegate.js';
import {
  createCheckTasksTool,
  createCancelTasksTool,
} from '../builtin/background-tasks.js';
import { InMemoryBackgroundTaskRegistry } from '@dongkseo/contracts';
import type {
  EventTransport,
  MessageEnvelope,
  RequestOptions,
  Subscription,
  TopicString,
  TransportDescription,
  AgentRegistry,
  AgentCard,
  AgentEvent,
  AgentInput,
  AgentRuntime,
  ToolContext,
} from '@dongkseo/contracts';
import { matchTopic, messageId } from '@dongkseo/contracts';

class FakeTransport implements EventTransport {
  private readonly subs = new Map<number, { pattern: string; handler: (e: MessageEnvelope) => Promise<void> }>();
  private nextId = 0;
  describe(): TransportDescription {
    return { kind: 'fake', deliveryGuarantee: 'at-most-once', durable: false, supportsConsumerGroups: false };
  }
  async publish(envelope: MessageEnvelope): Promise<void> {
    const matched = Array.from(this.subs.values()).filter(s => matchTopic(s.pattern, envelope.topic as TopicString));
    for (const m of matched) await m.handler(envelope);
  }
  subscribe(pattern: string, handler: (e: MessageEnvelope) => Promise<void>): Subscription {
    const id = this.nextId++;
    this.subs.set(id, { pattern, handler });
    return { unsubscribe: () => { this.subs.delete(id); } };
  }
  async request(topic: TopicString, payload: unknown, options?: RequestOptions): Promise<MessageEnvelope> {
    const requestId = messageId();
    return new Promise<MessageEnvelope>((resolve, reject) => {
      let resolved = false;
      const sub = this.subscribe('#', async (incoming) => {
        if (resolved) return;
        if (incoming.metadata.replyTo === requestId) {
          resolved = true; sub.unsubscribe(); clearTimeout(timer); resolve(incoming);
        }
      });
      const timer = setTimeout(() => { if (resolved) return; resolved = true; sub.unsubscribe(); reject(new Error('timeout')); }, options?.timeoutMs ?? 30_000);
      void this.publish({ id: requestId, topic, type: 'request', payload, metadata: { traceId: 't', spanId: 's', conversationId: 'c', tenantId: options?.tenantId ?? 'default', timestamp: Date.now() } });
    });
  }
  async close(): Promise<void> { this.subs.clear(); }
}

function makeCard(name: string, capability: string, subscribes: string[]): AgentCard {
  return { name, version: '0.1.0', description: name, capabilities: [capability], subscribes, publishes: [], tools: [], architecture: 'echo' };
}

function makeRegistry(cards: AgentCard[]): AgentRegistry {
  return {
    register: async () => {}, unregister: async () => {},
    get: async (n) => cards.find(c => c.name === n) ?? null,
    list: async () => [...cards],
    findByCapability: async (cap) => cards.filter(c => c.capabilities.includes(cap)),
    findBySubscription: async () => [],
  };
}

function baseCtx(): ToolContext {
  return {
    tenantId: 'tenant-A', workdir: '/tmp',
    secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

/** A controllable fake child runtime. Yields the given events; abort interrupts
 *  even a pending gate wait (mirrors a real runtime's AbortController). */
function makeRuntime(opts: {
  events?: AgentEvent[];
  gate?: Promise<void>;
  onExecute?: () => void;
}): AgentRuntime {
  let aborted = false;
  let abortReject: ((e: Error) => void) | null = null;
  return {
    execute: async function* (_input: AgentInput): AsyncGenerator<AgentEvent> {
      opts.onExecute?.();
      if (opts.gate) {
        await Promise.race([
          opts.gate,
          new Promise<void>((_resolve, reject) => { abortReject = reject; }),
        ]);
      }
      if (aborted) return;
      for (const e of opts.events ?? []) {
        if (aborted) return;
        yield e;
      }
    },
    abort: () => {
      aborted = true;
      abortReject?.(new Error('aborted'));
    },
  } as AgentRuntime;
}

const doneEvent = (content: string): AgentEvent => ({ type: 'done', content, toolCalls: [] });

describe('background subagent (delegate waitForResult:"async")', () => {
  it('folds the child result into the live parent turn via steerSelf', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([]);
    const runtime = makeRuntime({ events: [doneEvent('child-output-42')] });

    let resolveSteer: (m: string) => void;
    const steered = new Promise<string>((r) => { resolveSteer = r; });
    const steerSelf = vi.fn((m: string) => { resolveSteer(m); return true; });

    const tool = createDelegateTool({
      transport, registry,
      subagents: [{ type: 'compiled', name: 'child', description: 'c', runtime }],
    });

    const res = await tool.execute('j1',
      { capability: 'child', input: { prompt: 'go' }, waitForResult: 'async' },
      { ...baseCtx(), steerSelf });

    expect(res.type).toBe('text');
    if (res.type === 'text') expect(res.text).toMatch(/launched as background job/);

    const msg = await steered;
    expect(msg).toContain('background subagent "child" completed');
    expect(msg).toContain('child-output-42');
    expect(steerSelf).toHaveBeenCalledOnce();
  });

  it('delivers via deliverResult when the parent turn already ended (steerSelf=false)', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([]);
    const runtime = makeRuntime({ events: [doneEvent('late-result')] });

    let resolveDeliver: (v: { content: string; isError: boolean; label: string }) => void;
    const delivered = new Promise<{ content: string; isError: boolean; label: string }>((r) => { resolveDeliver = r; });
    const deliverResult = vi.fn((r: { taskId: string; kind: string; label: string; content: string; isError: boolean }) => { resolveDeliver(r); });
    const steerSelf = vi.fn(() => false); // parent turn is gone

    const tool = createDelegateTool({
      transport, registry, deliverResult,
      subagents: [{ type: 'compiled', name: 'child', description: 'c', runtime }],
    });

    await tool.execute('j2',
      { capability: 'child', input: { prompt: 'go' }, waitForResult: 'async' },
      { ...baseCtx(), steerSelf });

    const r = await delivered;
    expect(r.content).toBe('late-result');
    expect(r.isError).toBe(false);
    expect(r.label).toBe('child');
    expect(steerSelf).toHaveBeenCalledOnce();
    expect(deliverResult).toHaveBeenCalledOnce();
  });

  it('errors when neither steerSelf nor deliverResult is available', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([]);
    const runtime = makeRuntime({ events: [doneEvent('x')] });
    const tool = createDelegateTool({
      transport, registry,
      subagents: [{ type: 'compiled', name: 'child', description: 'c', runtime }],
    });
    const res = await tool.execute('j3',
      { capability: 'child', input: { prompt: 'go' }, waitForResult: 'async' },
      baseCtx()); // no steerSelf
    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/steerable parent loop or a deliverResult sink/);
  });

  it('cancel_subagent aborts the child and suppresses delivery', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([]);
    let releaseGate: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    const runtime = makeRuntime({ events: [doneEvent('should-not-deliver')], gate });

    const steerSelf = vi.fn(() => true);
    const deliverResult = vi.fn();
    const jobRegistry = new InMemoryBackgroundTaskRegistry();

    const tool = createDelegateTool({
      transport, registry, jobRegistry, deliverResult,
      subagents: [{ type: 'compiled', name: 'child', description: 'c', runtime }],
    });
    const cancelTool = createCancelTasksTool({ registry: jobRegistry });

    const res = await tool.execute('j4',
      { capability: 'child', input: { prompt: 'go' }, waitForResult: 'async' },
      { ...baseCtx(), steerSelf });
    expect(res.type).toBe('text');
    const jobId = jobRegistry.list()[0]!.taskId;

    const cancelRes = await cancelTool.execute('c1', { task_id: jobId }, baseCtx());
    expect(cancelRes.type).toBe('text');

    releaseGate!();
    await new Promise((r) => setTimeout(r, 10)); // let the detached pump unwind

    expect(jobRegistry.get(jobId)?.status).toBe('cancelled');
    expect(steerSelf).not.toHaveBeenCalled();
    expect(deliverResult).not.toHaveBeenCalled();
  });

  it('check_subagents lists launched jobs sharing the registry', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([]);
    const jobRegistry = new InMemoryBackgroundTaskRegistry();
    const runtime = makeRuntime({ events: [doneEvent('done')] });
    const steerSelf = vi.fn(() => true);

    const tool = createDelegateTool({
      transport, registry, jobRegistry,
      subagents: [{ type: 'compiled', name: 'child', description: 'c', runtime }],
    });
    const checkTool = createCheckTasksTool({ registry: jobRegistry });

    await tool.execute('j5', { capability: 'child', input: {}, waitForResult: 'async' }, { ...baseCtx(), steerSelf });
    await new Promise((r) => setTimeout(r, 10));

    const res = await checkTool.execute('k1', {}, baseCtx());
    expect(res.type).toBe('text');
    if (res.type === 'text') {
      const jobs = JSON.parse(res.text);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].label).toBe('child');
      expect(jobs[0].status).toBe('done');
    }
  });

  it('runs a capability-resolved peer via peerRuntimeFactory', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([makeCard('peer-agent', 'peer-cap', ['peer.requested'])]);
    const runtime = makeRuntime({ events: [doneEvent('peer-output')] });
    const peerRuntimeFactory = vi.fn(async () => runtime);

    let resolveSteer: (m: string) => void;
    const steered = new Promise<string>((r) => { resolveSteer = r; });
    const steerSelf = vi.fn((m: string) => { resolveSteer(m); return true; });

    const tool = createDelegateTool({ transport, registry, peerRuntimeFactory });
    const res = await tool.execute('j6',
      { capability: 'peer-cap', input: { prompt: 'go' }, waitForResult: 'async' },
      { ...baseCtx(), steerSelf });

    expect(res.type).toBe('text');
    expect(peerRuntimeFactory).toHaveBeenCalledOnce();
    const msg = await steered;
    expect(msg).toContain('background subagent "peer-agent" completed');
    expect(msg).toContain('peer-output');
  });

  it('returns an error (not a rejection) when peerRuntimeFactory throws', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([makeCard('peer-agent', 'peer-cap', ['peer.requested'])]);
    const peerRuntimeFactory = vi.fn(async () => { throw new Error('boom'); });
    const steerSelf = vi.fn(() => true);

    const tool = createDelegateTool({ transport, registry, peerRuntimeFactory });
    const res = await tool.execute('j8',
      { capability: 'peer-cap', input: { prompt: 'go' }, waitForResult: 'async' },
      { ...baseCtx(), steerSelf });

    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/Failed to build background subagent/);
    expect(steerSelf).not.toHaveBeenCalled();
  });

  it('aborts and errors a background child that exceeds backgroundJobTimeoutMs', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([]);
    // Child blocks on a gate that never opens within the timeout window.
    const neverGate = new Promise<void>(() => {});
    const runtime = makeRuntime({ events: [doneEvent('too-late')], gate: neverGate });

    let resolveSteer: (m: string) => void;
    const steered = new Promise<string>((r) => { resolveSteer = r; });
    const steerSelf = vi.fn((m: string) => { resolveSteer(m); return true; });

    const tool = createDelegateTool({
      transport, registry, backgroundJobTimeoutMs: 20,
      subagents: [{ type: 'compiled', name: 'slow', description: 'c', runtime }],
    });
    await tool.execute('j9',
      { capability: 'slow', input: {}, waitForResult: 'async' },
      { ...baseCtx(), steerSelf });

    const msg = await steered;
    expect(msg).toContain('background subagent "slow" failed');
    expect(msg).toMatch(/exceeded 20ms/);
  });

  it('falls back to legacy fire-and-forget when async target has no caller-owned runtime', async () => {
    const transport = new FakeTransport();
    const registry = makeRegistry([makeCard('peer-agent', 'peer-cap', ['peer.requested'])]);
    const steerSelf = vi.fn(() => true);

    // No inline subagent, no peerRuntimeFactory → startBackgroundSubagent returns null
    const tool = createDelegateTool({ transport, registry });
    const res = await tool.execute('j7',
      { capability: 'peer-cap', input: { prompt: 'go' }, waitForResult: 'async' },
      { ...baseCtx(), steerSelf });

    expect(res.type).toBe('text');
    if (res.type === 'text') expect(res.text).toMatch(/async/i);
    expect(steerSelf).not.toHaveBeenCalled(); // legacy path doesn't use the steer channel
  });
});
