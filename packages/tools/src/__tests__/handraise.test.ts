/**
 * handraise tool — unit tests.
 *
 * Tests the three recipient strategies (topic / capability / human), the
 * policy pre-flight, timeouts, HandraiseInbox round-trips, and the
 * approve/deny helper rules.
 *
 * An in-memory FakeTransport stands in for a real EventTransport — it
 * implements only the methods handraise touches (publish / subscribe /
 * request / describe / close) and dispatches synchronously so the tests
 * are deterministic.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createHandraiseTool,
  HandraisePolicy,
  HandraiseInbox,
  approveMatching,
  denyMatching,
} from '../index.js';
import type {
  EventTransport,
  MessageEnvelope,
  RequestOptions,
  Subscription,
  TopicString,
  TransportDescription,
  AgentRegistry,
  AgentCard,
  ToolContext,
} from '@dongkseo/contracts';
import { matchTopic, messageId } from '@dongkseo/contracts';

// ─── Fake transport: wildcard subscribe, inline dispatch, replyTo matching ─

class FakeTransport implements EventTransport {
  private readonly subs = new Map<number, { pattern: string; handler: (e: MessageEnvelope) => Promise<void> }>();
  private nextId = 0;
  public readonly published: MessageEnvelope[] = [];

  describe(): TransportDescription {
    return {
      kind: 'fake',
      deliveryGuarantee: 'at-most-once',
      durable: false,
      supportsConsumerGroups: false,
    };
  }

  async publish(envelope: MessageEnvelope): Promise<void> {
    this.published.push(envelope);
    const matched = Array.from(this.subs.values()).filter(s =>
      matchTopic(s.pattern, envelope.topic as TopicString),
    );
    // Run handlers sequentially to avoid race flakes in tests
    for (const m of matched) await m.handler(envelope);
  }

  subscribe(pattern: string, handler: (e: MessageEnvelope) => Promise<void>): Subscription {
    const id = this.nextId++;
    this.subs.set(id, { pattern, handler });
    return { unsubscribe: () => { this.subs.delete(id); } };
  }

  async request(
    topic: TopicString,
    payload: unknown,
    options?: RequestOptions,
  ): Promise<MessageEnvelope> {
    const requestId = messageId();
    const timeoutMs = options?.timeoutMs ?? 30_000;

    return new Promise<MessageEnvelope>((resolve, reject) => {
      let resolved = false;
      const subscription = this.subscribe('#', async (incoming) => {
        if (resolved) return;
        if (incoming.metadata.replyTo === requestId) {
          resolved = true;
          subscription.unsubscribe();
          clearTimeout(timer);
          resolve(incoming);
        }
      });
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        subscription.unsubscribe();
        reject(new Error(`Request to ${String(topic)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // fire the request envelope
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

  async close(): Promise<void> {
    this.subs.clear();
  }
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

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('handraise tool — human suspend + agent-to-agent round-trip', () => {
  it('human recipient suspends and publishes the question to the inbox', async () => {
    const transport = new FakeTransport();
    const inbox = new HandraiseInbox({ transport, channels: ['default'] });
    inbox.start();

    const tool = createHandraiseTool({ transport });

    const result = await tool.execute('call-1', {
      question: 'Which account to charge?',
      recipient: { type: 'human' },
    }, makeCtx());

    // Human handraise suspends the turn — no blocking, no timeout.
    expect(result.type).toBe('suspend');
    const pendingId = result.type === 'suspend' ? result.pendingId : '';
    expect(pendingId).toBeTruthy();

    // The question landed in the inbox; envelope id == pendingId so the reply's
    // metadata.replyTo correlates straight back to this parked turn.
    const [entry] = inbox.list();
    expect(entry).toBeDefined();
    expect(entry.envelope.id).toBe(pendingId);
    const payload = entry.envelope.payload as { question?: string; pendingId?: string };
    expect(payload.question).toContain('account');
    expect(payload.pendingId).toBe(pendingId);

    inbox.stop();
  });

  it('explicit { type: topic } routes to the exact topic', async () => {
    const transport = new FakeTransport();

    // Set up a subscriber on our custom topic that auto-answers
    transport.subscribe('my.custom.handraise', async (env) => {
      await transport.publish({
        id: messageId(),
        topic: 'my.custom.handraise.reply',
        type: 'result',
        payload: { answer: { ok: true } },
        metadata: {
          ...env.metadata,
          replyTo: env.id,
          timestamp: Date.now(),
        },
      });
    });

    const tool = createHandraiseTool({ transport });
    const result = await tool.execute('call-x', {
      question: 'custom?',
      recipient: { type: 'topic', topic: 'my.custom.handraise' },
      timeoutMs: 1000,
    }, makeCtx());

    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('"ok":true');
  });

  it('agent-to-agent (topic) recipient returns a non-error text result on timeout', async () => {
    const transport = new FakeTransport();
    const tool = createHandraiseTool({ transport });

    const result = await tool.execute('call-timeout', {
      question: 'nobody is home',
      recipient: { type: 'topic', topic: 'nobody.listens' },
      timeoutMs: 30, // will time out — no responder on this topic
    }, makeCtx());

    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toMatch(/no-answer/);
  });

  it('errors if question is missing', async () => {
    const transport = new FakeTransport();
    const tool = createHandraiseTool({ transport });
    const result = await tool.execute('call-0', {
      recipient: { type: 'human' },
    }, makeCtx());
    expect(result.type).toBe('error');
  });
});

describe('handraise tool — capability recipient via registry', () => {
  it('routes by capability using the first matching agent', async () => {
    const transport = new FakeTransport();

    // Set up a stub registry with one agent that can answer billing questions.
    const card: AgentCard = {
      name: 'billing-approver',
      version: '0.1.0',
      description: '',
      capabilities: ['billing.approval'],
      subscribes: ['billing.approve'],
      publishes: ['billing.approved'],
      tools: [],
      architecture: 'echo',
    };
    const registry: AgentRegistry = {
      register: async () => {},
      unregister: async () => {},
      get: async () => card,
      list: async () => [card],
      findByCapability: async (cap) => (cap === 'billing.approval' ? [card] : []),
      findBySubscription: async () => [],
    };

    // Subscribe directly to billing.approve and auto-answer
    transport.subscribe('billing.approve', async (env) => {
      await transport.publish({
        id: messageId(),
        topic: 'billing.approved',
        type: 'result',
        payload: { answer: { approved: true } },
        metadata: { ...env.metadata, replyTo: env.id, timestamp: Date.now() },
      });
    });

    const tool = createHandraiseTool({ transport, registry });
    const result = await tool.execute('call-cap', {
      question: 'refund $10?',
      recipient: { type: 'capability', capability: 'billing.approval' },
      timeoutMs: 1000,
    }, makeCtx());

    expect(result.type).toBe('text');
    if (result.type === 'text') expect(result.text).toContain('"approved":true');
  });

  it('errors if no agent declares the requested capability', async () => {
    const transport = new FakeTransport();
    const registry: AgentRegistry = {
      register: async () => {},
      unregister: async () => {},
      get: async () => null,
      list: async () => [],
      findByCapability: async () => [],
      findBySubscription: async () => [],
    };

    const tool = createHandraiseTool({ transport, registry });
    const result = await tool.execute('call-none', {
      question: 'x?',
      recipient: { type: 'capability', capability: 'missing' },
      timeoutMs: 1000,
    }, makeCtx());
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/capability/);
  });

  it('errors if capability recipient is used without a registry', async () => {
    const transport = new FakeTransport();
    const tool = createHandraiseTool({ transport }); // no registry
    const result = await tool.execute('call-nr', {
      question: 'x?',
      recipient: { type: 'capability', capability: 'anything' },
    }, makeCtx());
    expect(result.type).toBe('error');
    if (result.type === 'error') expect(result.message).toMatch(/registry/);
  });
});

describe('handraise tool — policy pre-flight', () => {
  it('short-circuits with an auto-answer when a rule matches', async () => {
    const transport = new FakeTransport();
    // Inbox is running but should NOT receive anything — the policy wins first
    const inbox = new HandraiseInbox({ transport });
    inbox.start();

    const policy = new HandraisePolicy([
      approveMatching(
        'tmp-cleanup',
        (ctx) => ctx.question.toLowerCase().includes('delete') && ctx.question.includes('/tmp'),
        { approved: true },
        'Safe: /tmp only',
      ),
    ]);

    const tool = createHandraiseTool({ transport, policy });
    const result = await tool.execute('call-policy', {
      question: 'Delete files older than 30d in /tmp?',
      recipient: { type: 'human' },
      timeoutMs: 5000,
    }, makeCtx());

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('"approved":true');
      expect(result.text).toContain('Safe: /tmp only');
    }

    // The inbox must NOT have seen the request — policy intercepted it
    expect(inbox.size()).toBe(0);
    inbox.stop();
  });

  it('falls through to the recipient when no rule matches (human → suspend)', async () => {
    const transport = new FakeTransport();
    const inbox = new HandraiseInbox({ transport });
    inbox.start();
    const policy = new HandraisePolicy([
      approveMatching(
        'tmp-rule',
        (ctx) => ctx.question.includes('/tmp'),
        { approved: true },
      ),
    ]);
    const tool = createHandraiseTool({ transport, policy });

    const result = await tool.execute('call-ft', {
      question: 'Delete /etc/passwd?', // does NOT match the /tmp rule
      recipient: { type: 'human' },
    }, makeCtx());

    // No rule matched → escalates to the human → suspends (no timeout, no answer inline).
    expect(result.type).toBe('suspend');
    expect(inbox.size()).toBe(1);
    inbox.stop();
  });

  it('denyMatching rule returns a reject answer without hitting a human', async () => {
    const transport = new FakeTransport();
    const policy = new HandraisePolicy([
      denyMatching(
        'no-prod-deploy-fridays',
        (ctx) => (ctx.context as { day?: string })?.day === 'Friday',
        'No deploys on Fridays',
      ),
    ]);

    const tool = createHandraiseTool({ transport, policy });
    const result = await tool.execute('call-deny', {
      question: 'Deploy to prod?',
      recipient: { type: 'human' },
      context: { day: 'Friday' },
      timeoutMs: 5000,
    }, makeCtx());

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toContain('"approved":false');
      expect(result.text).toContain('Friday');
    }
  });
});

describe('HandraiseInbox direct operations', () => {
  it('list/size/answer/reject lifecycle', async () => {
    const transport = new FakeTransport();
    const inbox = new HandraiseInbox({ transport, channels: ['default', 'security'] });
    inbox.start();

    // Publish a request to the security channel directly
    await transport.publish({
      id: 'req-1',
      topic: 'handraise.human.security',
      type: 'request',
      payload: { question: 'suspicious login?', callId: 'c-1' },
      metadata: {
        traceId: 't', spanId: 's', conversationId: 'c',
        tenantId: 'tenant-X', timestamp: Date.now(),
      },
    });

    expect(inbox.size()).toBe(1);
    const [pending] = inbox.list();
    expect(pending.channel).toBe('security');
    expect((pending.envelope.payload as { question: string }).question).toBe('suspicious login?');

    await inbox.answer(pending.id, { ok: true });
    expect(inbox.size()).toBe(0);

    // A reply envelope should have been published with replyTo = req-1
    const reply = transport.published.find(p => p.metadata.replyTo === 'req-1');
    expect(reply).toBeDefined();
    expect((reply?.payload as { answer: { ok: boolean } }).answer.ok).toBe(true);

    inbox.stop();
  });

  it('reject() publishes a rejection answer', async () => {
    const transport = new FakeTransport();
    const inbox = new HandraiseInbox({ transport });
    inbox.start();

    await transport.publish({
      id: 'req-2',
      topic: 'handraise.human.default',
      type: 'request',
      payload: { question: 'x?', callId: 'c-2' },
      metadata: {
        traceId: 't', spanId: 's', conversationId: 'c',
        tenantId: 'tenant-X', timestamp: Date.now(),
      },
    });

    const [pending] = inbox.list();
    await inbox.reject(pending.id, 'not during office hours');

    const reply = transport.published.find(p => p.metadata.replyTo === 'req-2');
    expect(reply).toBeDefined();
    const payload = reply?.payload as { answer: { rejected: boolean; reason: string } };
    expect(payload.answer.rejected).toBe(true);
    expect(payload.answer.reason).toBe('not during office hours');
    inbox.stop();
  });

  it('throws when answering an unknown id', async () => {
    const transport = new FakeTransport();
    const inbox = new HandraiseInbox({ transport });
    inbox.start();
    await expect(inbox.answer('nope', {})).rejects.toThrow(/No pending handraise/);
    inbox.stop();
  });
});
