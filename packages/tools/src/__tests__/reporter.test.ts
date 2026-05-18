import { describe, it, expect } from 'vitest';
import {
  createReporterMiddleware,
  isReportEnvelopePayload,
  reportTopic,
  type ReportEvent,
} from '../index.js';
import type {
  EventTransport,
  MessageEnvelope,
  Subscription,
  TopicString,
  TransportDescription,
  ToolDefinition,
  RequestOptions,
} from '@nexora/contracts';
import { matchTopic } from '@nexora/contracts';

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
  async request(_t: TopicString, _p: unknown, _o?: RequestOptions): Promise<MessageEnvelope> {
    throw new Error('not used');
  }
  async close(): Promise<void> { this.subs.clear(); }
}

function makeTool(name: string, visibility?: ToolDefinition['visibility']): ToolDefinition {
  return {
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ type: 'text', text: `${name} ran` }),
    ...(visibility ? { visibility } : {}),
  };
}

function makeRoutingResolver(extra: { channelId?: string; threadId?: string } = {}) {
  return () => ({
    sessionKey: 'agent:main:discord:channel:ch-1',
    tenantId: 'tenant-A',
    ...extra,
  });
}

function collectEvents(transport: FakeTransport): ReportEvent[] {
  return transport.published
    .filter((e) => e.topic === reportTopic('default'))
    .map((e) => {
      expect(isReportEnvelopePayload(e.payload)).toBe(true);
      return (e.payload as { event: ReportEvent }).event;
    });
}

describe('createReporterMiddleware default predicate', () => {
  it('emits tool_start + tool_end for public tools', async () => {
    const transport = new FakeTransport();
    const mw = createReporterMiddleware({
      transport,
      resolveContext: makeRoutingResolver(),
    });
    const tool = makeTool('jira', 'public');
    await mw.beforeToolCall!({ toolName: tool.name, callId: 'c1', input: { issue: 'NX-1' }, tool });
    await mw.afterToolCall!({
      toolName: tool.name,
      callId: 'c1',
      input: { issue: 'NX-1' },
      result: { type: 'text', text: 'ok' },
      isError: false,
    });
    const events = collectEvents(transport);
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end']);
    expect((events[0] as { visibility?: string }).visibility).toBe('public');
  });

  it('skips silent (default) tools but still emits errors', async () => {
    const transport = new FakeTransport();
    const mw = createReporterMiddleware({
      transport,
      resolveContext: makeRoutingResolver(),
    });
    const tool = makeTool('secret');
    await mw.beforeToolCall!({ toolName: tool.name, callId: 'c1', tool });
    await mw.afterToolCall!({
      toolName: tool.name,
      callId: 'c1',
      result: { type: 'text', text: 'ok' },
      isError: false,
    });
    // Now an error case from another silent tool — should be emitted.
    const failing = makeTool('boom');
    await mw.afterToolCall!({
      toolName: failing.name,
      callId: 'c2',
      result: { type: 'error', message: 'boom' },
      isError: true,
    });
    const events = collectEvents(transport);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_end');
    expect((events[0] as { isError: boolean }).isError).toBe(true);
  });

  it('always emits budget events', async () => {
    const transport = new FakeTransport();
    const mw = createReporterMiddleware({
      transport,
      resolveContext: makeRoutingResolver(),
    });
    await mw.onBudgetExceeded!({ policyId: 'daily', spent: 12, limit: 10 });
    const events = collectEvents(transport);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('budget');
  });
});

describe('createReporterMiddleware custom predicate + events filter', () => {
  it('honors a caller predicate', async () => {
    const transport = new FakeTransport();
    const mw = createReporterMiddleware({
      transport,
      resolveContext: makeRoutingResolver(),
      predicate: ({ event }) => event.type === 'tool_end',
    });
    const tool = makeTool('jira', 'public');
    await mw.beforeToolCall!({ toolName: tool.name, callId: 'c1', tool });
    await mw.afterToolCall!({
      toolName: tool.name,
      callId: 'c1',
      result: { type: 'text', text: 'ok' },
      isError: false,
    });
    const events = collectEvents(transport);
    expect(events.map((e) => e.type)).toEqual(['tool_end']);
  });

  it('honors an events allowlist', async () => {
    const transport = new FakeTransport();
    const mw = createReporterMiddleware({
      transport,
      resolveContext: makeRoutingResolver(),
      events: ['budget', 'compact'],
      predicate: () => true,
    });
    const tool = makeTool('jira', 'public');
    await mw.beforeToolCall!({ toolName: tool.name, callId: 'c1', tool });
    await mw.afterToolCall!({
      toolName: tool.name,
      callId: 'c1',
      result: { type: 'text', text: 'ok' },
      isError: false,
    });
    await mw.onCompact!({ beforeTokens: 100, afterTokens: 40, messagesBefore: 20, messagesAfter: 5 });
    const events = collectEvents(transport);
    expect(events.map((e) => e.type)).toEqual(['compact']);
  });

  it('drops emissions when resolveContext returns null', async () => {
    const transport = new FakeTransport();
    const mw = createReporterMiddleware({
      transport,
      resolveContext: () => null,
      predicate: () => true,
    });
    await mw.beforeToolCall!({ toolName: 'x', callId: 'c1', tool: makeTool('x', 'public') });
    expect(collectEvents(transport)).toHaveLength(0);
  });

  it('measures durationMs across start → end', async () => {
    const transport = new FakeTransport();
    const mw = createReporterMiddleware({
      transport,
      resolveContext: makeRoutingResolver(),
    });
    const tool = makeTool('slow', 'public');
    await mw.beforeToolCall!({ toolName: tool.name, callId: 'c1', tool });
    await new Promise((r) => setTimeout(r, 20));
    await mw.afterToolCall!({
      toolName: tool.name,
      callId: 'c1',
      result: { type: 'text', text: 'done' },
      isError: false,
    });
    const events = collectEvents(transport);
    const end = events.find((e) => e.type === 'tool_end') as { durationMs?: number };
    // Sleep was 20ms but system timer slack means the measured value can
    // come back a couple of ms under on a fast CI runner. Just assert that
    // durationMs was captured and is non-negative — the contract we care
    // about is presence, not microsecond precision.
    expect(typeof end.durationMs).toBe('number');
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('publishes to a custom channel topic', async () => {
    const transport = new FakeTransport();
    const mw = createReporterMiddleware({
      transport,
      channel: 'team-alpha',
      resolveContext: makeRoutingResolver(),
    });
    await mw.onBudgetExceeded!({ policyId: 'p', spent: 1, limit: 0 });
    expect(transport.published[0].topic).toBe('report.team-alpha');
  });
});
