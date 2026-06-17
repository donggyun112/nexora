import { describe, it, expect, vi } from 'vitest';
import { bridgeDiscordReports } from '../discord-reports.js';
import type {
  DiscordReportChannel,
  DiscordReportMessage,
} from '../discord-reports.js';
import {
  reportTopic,
  type ReportEvent,
  type ReportEnvelopePayload,
} from '@dongkseo/tools';
import type {
  EventTransport,
  MessageEnvelope,
  Subscription,
  TopicString,
  TransportDescription,
  RequestOptions,
} from '@dongkseo/contracts';
import { matchTopic, messageId } from '@dongkseo/contracts';

class FakeTransport implements EventTransport {
  private readonly subs = new Map<number, { pattern: string; handler: (e: MessageEnvelope) => Promise<void> }>();
  private nextId = 0;
  describe(): TransportDescription {
    return { kind: 'fake', deliveryGuarantee: 'at-most-once', durable: false, supportsConsumerGroups: false };
  }
  async publish(env: MessageEnvelope): Promise<void> {
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

function makeChannel() {
  const sent: { content?: string; embeds?: unknown[] }[] = [];
  const edits: { content?: string; embeds?: unknown[] }[] = [];
  const sink: DiscordReportChannel = {
    async send(payload) {
      sent.push(payload);
      const msg: DiscordReportMessage = {
        id: `msg-${sent.length}`,
        edit: vi.fn(async (p) => { edits.push(p); }),
      };
      return msg;
    },
  };
  return { sink, sent, edits };
}

async function publishEvent(transport: FakeTransport, event: ReportEvent, channel = 'default') {
  const payload: ReportEnvelopePayload = { event };
  await transport.publish({
    id: messageId(),
    topic: reportTopic(channel) as TopicString,
    type: 'event',
    payload,
    metadata: {
      traceId: 't', spanId: 's', conversationId: 'c',
      tenantId: 'tenant-A', timestamp: Date.now(),
    },
  });
}

describe('bridgeDiscordReports', () => {
  it('posts an embed for a single tool_start', async () => {
    const transport = new FakeTransport();
    const channel = makeChannel();
    bridgeDiscordReports({
      transport,
      resolveChannel: async () => channel.sink,
    });
    await publishEvent(transport, {
      type: 'tool_start',
      toolName: 'jira',
      callId: 'c1',
      sessionKey: 'sk',
      channelId: 'ch-1',
      timestamp: Date.now(),
    });
    expect(channel.sent).toHaveLength(1);
    const embed = (channel.sent[0].embeds as { title: string }[])[0];
    expect(embed.title).toContain('jira');
  });

  it('edits the same message on tool_end when liveEdit is on', async () => {
    const transport = new FakeTransport();
    const channel = makeChannel();
    bridgeDiscordReports({
      transport,
      resolveChannel: async () => channel.sink,
    });
    await publishEvent(transport, {
      type: 'tool_start',
      toolName: 'jira',
      callId: 'c1',
      sessionKey: 'sk',
      channelId: 'ch-1',
      timestamp: Date.now(),
    });
    await publishEvent(transport, {
      type: 'tool_end',
      toolName: 'jira',
      callId: 'c1',
      sessionKey: 'sk',
      channelId: 'ch-1',
      isError: false,
      durationMs: 120,
      timestamp: Date.now(),
    });
    expect(channel.sent).toHaveLength(1);
    expect(channel.edits).toHaveLength(1);
    expect(channel.edits[0].embeds).toBeDefined();
  });

  it('sends a fresh message on tool_end when liveEdit is off', async () => {
    const transport = new FakeTransport();
    const channel = makeChannel();
    bridgeDiscordReports({
      transport,
      liveEdit: false,
      resolveChannel: async () => channel.sink,
    });
    await publishEvent(transport, {
      type: 'tool_start',
      toolName: 'jira',
      callId: 'c1',
      sessionKey: 'sk',
      channelId: 'ch-1',
      timestamp: Date.now(),
    });
    await publishEvent(transport, {
      type: 'tool_end',
      toolName: 'jira',
      callId: 'c1',
      sessionKey: 'sk',
      channelId: 'ch-1',
      isError: false,
      timestamp: Date.now(),
    });
    expect(channel.sent).toHaveLength(2);
    expect(channel.edits).toHaveLength(0);
  });

  it('routes to threadId first, falling back to channelId', async () => {
    const transport = new FakeTransport();
    const resolveChannel = vi.fn(async () => makeChannel().sink);
    bridgeDiscordReports({ transport, resolveChannel });
    await publishEvent(transport, {
      type: 'tool_start',
      toolName: 'jira',
      callId: 'c1',
      sessionKey: 'sk',
      channelId: 'ch-1',
      threadId: 'th-9',
      timestamp: Date.now(),
    });
    expect(resolveChannel).toHaveBeenCalledWith('th-9');
    await publishEvent(transport, {
      type: 'tool_start',
      toolName: 'jira',
      callId: 'c2',
      sessionKey: 'sk',
      channelId: 'ch-1',
      timestamp: Date.now(),
    });
    expect(resolveChannel).toHaveBeenCalledWith('ch-1');
  });

  it('honors a custom renderer', async () => {
    const transport = new FakeTransport();
    const channel = makeChannel();
    bridgeDiscordReports({
      transport,
      resolveChannel: async () => channel.sink,
      renderers: {
        budget: (ev) => ({ content: `BUDGET ${ev.policyId} ${ev.spent}/${ev.limit}`, embeds: [] }),
      },
    });
    await publishEvent(transport, {
      type: 'budget',
      sessionKey: 'sk',
      channelId: 'ch-1',
      policyId: 'daily',
      spent: 12,
      limit: 10,
      timestamp: Date.now(),
    });
    expect(channel.sent[0].content).toBe('BUDGET daily 12/10');
  });

  it('drops events with no channel routing', async () => {
    const transport = new FakeTransport();
    const channel = makeChannel();
    bridgeDiscordReports({
      transport,
      resolveChannel: async () => channel.sink,
    });
    await publishEvent(transport, {
      type: 'tool_start',
      toolName: 'jira',
      callId: 'c1',
      sessionKey: 'sk',
      timestamp: Date.now(),
    });
    expect(channel.sent).toHaveLength(0);
  });

  it('stop() unsubscribes', async () => {
    const transport = new FakeTransport();
    const channel = makeChannel();
    const bridge = bridgeDiscordReports({
      transport,
      resolveChannel: async () => channel.sink,
    });
    bridge.stop();
    await publishEvent(transport, {
      type: 'tool_start',
      toolName: 'jira',
      callId: 'c1',
      sessionKey: 'sk',
      channelId: 'ch-1',
      timestamp: Date.now(),
    });
    expect(channel.sent).toHaveLength(0);
  });
});
