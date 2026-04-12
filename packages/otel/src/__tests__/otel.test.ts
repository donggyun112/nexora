/**
 * OTel integration tests — verifies span creation and attribute attachment
 * using a fake tracer that captures spans in memory instead of exporting
 * them to a real collector.
 */

import { describe, it, expect } from 'vitest';
import { OTelTransport } from '../transport-middleware.js';
import { createOTelAgentMiddleware } from '../agent-middleware.js';
import type { Tracer, Span, SpanOptions, SpanContext } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import type {
  EventTransport,
  MessageEnvelope,
  Subscription,
  RequestOptions,
  TopicString,
  TransportDescription,
} from '@nexora/contracts';
import { matchTopic, messageId } from '@nexora/contracts';

// ─── Fake OTel tracer that captures spans in memory ───────────────────────

interface CapturedSpan {
  name: string;
  kind?: number;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  ended: boolean;
  exceptions: Error[];
}

class FakeSpan implements Partial<Span> {
  readonly captured: CapturedSpan;

  constructor(name: string, options?: SpanOptions) {
    this.captured = {
      name,
      kind: options?.kind,
      attributes: { ...((options?.attributes ?? {}) as Record<string, unknown>) },
      ended: false,
      exceptions: [],
    };
  }

  setAttribute(key: string, value: unknown): this {
    this.captured.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Record<string, unknown>): this {
    Object.assign(this.captured.attributes, attrs);
    return this;
  }

  setStatus(status: { code: number; message?: string }): this {
    this.captured.status = status;
    return this;
  }

  recordException(err: Error): void {
    this.captured.exceptions.push(err);
  }

  end(): void {
    this.captured.ended = true;
  }

  // Stubs for the rest of the Span interface
  spanContext(): SpanContext {
    return { traceId: '0', spanId: '0', traceFlags: 0 };
  }
  isRecording(): boolean { return true; }
  updateName(): this { return this; }
  addEvent(): this { return this; }
  addLink(): this { return this; }
  addLinks(): this { return this; }
}

class FakeTracer {
  readonly spans: CapturedSpan[] = [];

  startSpan(name: string, options?: SpanOptions): FakeSpan {
    const span = new FakeSpan(name, options);
    this.spans.push(span.captured);
    return span;
  }

  // Stubs
  startActiveSpan(): never { throw new Error('not used in tests'); }
}

// ─── Fake EventTransport ──────────────────────────────────────────────────

class InlineTransport implements EventTransport {
  private readonly subs = new Map<number, { pattern: string; handler: (e: MessageEnvelope) => Promise<void> }>();
  private nextId = 0;

  describe(): TransportDescription {
    return { kind: 'inline', deliveryGuarantee: 'at-most-once', durable: false, supportsConsumerGroups: false };
  }

  async publish(envelope: MessageEnvelope): Promise<void> {
    const matched = Array.from(this.subs.values()).filter(s =>
      matchTopic(s.pattern, envelope.topic as TopicString),
    );
    for (const m of matched) await m.handler(envelope);
  }

  subscribe(pattern: string, handler: (e: MessageEnvelope) => Promise<void>): Subscription {
    const id = this.nextId++;
    this.subs.set(id, { pattern, handler });
    return { unsubscribe: () => { this.subs.delete(id); } };
  }

  async request(topic: TopicString, payload: unknown, options?: RequestOptions): Promise<MessageEnvelope> {
    const reqId = messageId();
    return new Promise<MessageEnvelope>((resolve, reject) => {
      let resolved = false;
      const sub = this.subscribe('#', async (incoming) => {
        if (resolved) return;
        if (incoming.metadata.replyTo === reqId) {
          resolved = true; sub.unsubscribe(); clearTimeout(t); resolve(incoming);
        }
      });
      const t = setTimeout(() => { if (!resolved) { resolved = true; sub.unsubscribe(); reject(new Error('timeout')); } }, options?.timeoutMs ?? 5000);
      void this.publish({
        id: reqId, topic, type: 'request', payload,
        metadata: { traceId: 't', spanId: 's', conversationId: 'c', tenantId: options?.tenantId ?? 'd', timestamp: Date.now() },
      });
    });
  }

  async close(): Promise<void> { this.subs.clear(); }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('OTelTransport', () => {
  it('creates PRODUCER span on publish with envelope metadata as attributes', async () => {
    const tracer = new FakeTracer();
    const inner = new InlineTransport();
    const transport = new OTelTransport(inner, { tracer: tracer as unknown as Tracer });

    await transport.publish({
      id: 'e1', topic: 'test.topic', type: 'event', payload: {},
      metadata: { traceId: 'trace-1', spanId: 'span-1', conversationId: 'conv-1', tenantId: 'tenant-A', timestamp: Date.now() },
    });

    expect(tracer.spans).toHaveLength(1);
    const span = tracer.spans[0];
    expect(span.name).toContain('publish');
    expect(span.name).toContain('test.topic');
    expect(span.attributes['nexora.topic']).toBe('test.topic');
    expect(span.attributes['nexora.traceId']).toBe('trace-1');
    expect(span.attributes['nexora.tenantId']).toBe('tenant-A');
    expect(span.ended).toBe(true);
    expect(span.status?.code).toBe(SpanStatusCode.OK);
  });

  it('creates CONSUMER span per handler invocation', async () => {
    const tracer = new FakeTracer();
    const inner = new InlineTransport();
    const transport = new OTelTransport(inner, { tracer: tracer as unknown as Tracer });

    const received: string[] = [];
    transport.subscribe('work.*', async (env) => {
      received.push(env.topic);
    });

    await transport.publish({
      id: 'e2', topic: 'work.requested', type: 'request', payload: {},
      metadata: { traceId: 't', spanId: 's', conversationId: 'c', tenantId: 'x', timestamp: Date.now() },
    });

    expect(received).toEqual(['work.requested']);
    // 2 spans: one for publish, one for the handler
    expect(tracer.spans).toHaveLength(2);
    const handlerSpan = tracer.spans.find(s => s.name.includes('handle'));
    expect(handlerSpan).toBeDefined();
    expect(handlerSpan?.attributes['nexora.subscribePattern']).toBe('work.*');
    expect(handlerSpan?.ended).toBe(true);
  });

  it('records exception on handler throw', async () => {
    const tracer = new FakeTracer();
    const inner = new InlineTransport();
    const transport = new OTelTransport(inner, { tracer: tracer as unknown as Tracer });

    transport.subscribe('bad', async () => { throw new Error('boom'); });

    await expect(transport.publish({
      id: 'e3', topic: 'bad', type: 'event', payload: {},
      metadata: { traceId: 't', spanId: 's', conversationId: 'c', tenantId: 'x', timestamp: Date.now() },
    })).rejects.toThrow('boom');

    const handlerSpan = tracer.spans.find(s => s.name.includes('handle'));
    expect(handlerSpan?.status?.code).toBe(SpanStatusCode.ERROR);
    expect(handlerSpan?.exceptions).toHaveLength(1);
  });

  it('creates CLIENT span for request/reply', async () => {
    const tracer = new FakeTracer();
    const inner = new InlineTransport();
    const transport = new OTelTransport(inner, { tracer: tracer as unknown as Tracer });

    // Auto-responder
    inner.subscribe('echo', async (env) => {
      await inner.publish({
        id: messageId(), topic: 'echo.reply', type: 'result',
        payload: { echo: true },
        metadata: { ...env.metadata, replyTo: env.id, timestamp: Date.now() },
      });
    });

    const reply = await transport.request('echo' as TopicString, { msg: 'hi' }, { timeoutMs: 1000 });
    expect((reply.payload as { echo: boolean }).echo).toBe(true);

    const requestSpan = tracer.spans.find(s => s.name.includes('request'));
    expect(requestSpan).toBeDefined();
    expect(requestSpan?.status?.code).toBe(SpanStatusCode.OK);
    expect(requestSpan?.attributes['nexora.replyTopic']).toBe('echo.reply');
  });

  it('forwards describe() from inner transport', async () => {
    const inner = new InlineTransport();
    const transport = new OTelTransport(inner);
    const desc = transport.describe();
    expect(desc.kind).toBe('inline');
    expect(desc.notes).toContain('OTel');
  });
});

describe('createOTelAgentMiddleware', () => {
  it('creates execution span with tool count and status', () => {
    const tracer = new FakeTracer();
    const mw = createOTelAgentMiddleware({ tracer: tracer as unknown as Tracer });

    // Use same input reference so WeakMap can correlate before/after
    const input = { prompt: 'hi' };
    mw.beforeExecution!({ tools: [{}, {}, {}], systemPrompt: '', input });
    mw.afterExecution!({ events: [1, 2, 3, 4, 5], finalContent: 'done', input });

    expect(tracer.spans).toHaveLength(1);
    expect(tracer.spans[0].name).toContain('execute');
    expect(tracer.spans[0].attributes['nexora.agent.tools']).toBe('3');
    expect(tracer.spans[0].attributes['nexora.agent.events']).toBe(5);
    expect(tracer.spans[0].status?.code).toBe(SpanStatusCode.OK);
    expect(tracer.spans[0].ended).toBe(true);
  });

  it('creates per-tool spans between before/afterToolCall', () => {
    const tracer = new FakeTracer();
    const mw = createOTelAgentMiddleware({ tracer: tracer as unknown as Tracer });

    mw.beforeToolCall!({ toolName: 'read', callId: 'c1', input: {}, tool: {} });
    mw.afterToolCall!({ toolName: 'read', callId: 'c1', input: {}, result: {}, isError: false });

    mw.beforeToolCall!({ toolName: 'exec', callId: 'c2', input: {}, tool: {} });
    mw.afterToolCall!({ toolName: 'exec', callId: 'c2', input: {}, result: {}, isError: true });

    const toolSpans = tracer.spans.filter(s => s.name.includes('tool'));
    expect(toolSpans).toHaveLength(2);
    expect(toolSpans[0].attributes['nexora.tool.name']).toBe('read');
    expect(toolSpans[0].status?.code).toBe(SpanStatusCode.OK);
    expect(toolSpans[1].attributes['nexora.tool.name']).toBe('exec');
    expect(toolSpans[1].status?.code).toBe(SpanStatusCode.ERROR);
  });

  it('records exception on afterExecution with error', () => {
    const tracer = new FakeTracer();
    const mw = createOTelAgentMiddleware({ tracer: tracer as unknown as Tracer });

    const input = {};
    mw.beforeExecution!({ tools: [], systemPrompt: '', input });
    const err = new Error('llm crash');
    mw.afterExecution!({ events: [], finalContent: '', input, error: err });

    expect(tracer.spans[0].status?.code).toBe(SpanStatusCode.ERROR);
    expect(tracer.spans[0].exceptions).toHaveLength(1);
  });
});
