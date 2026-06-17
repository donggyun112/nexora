import { describe, it, expect, vi } from 'vitest';
import { bridgeDiscordApprovals } from '../discord-approvals.js';
import type {
  DiscordApprovalChannel,
  DiscordApprovalMessage,
  DiscordApprovalsClient,
  DiscordButtonInteraction,
} from '../discord-approvals.js';
import { HandraiseInbox } from '@dongkseo/tools';
import type {
  ApprovalRequest,
  ApprovalReply,
} from '@dongkseo/tools';
import type {
  EventTransport,
  MessageEnvelope,
  RequestOptions,
  Subscription,
  TopicString,
  TransportDescription,
} from '@dongkseo/contracts';
import { matchTopic, messageId } from '@dongkseo/contracts';

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
        reject(new Error(`timeout after ${timeoutMs}ms`));
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

function makeFakeClient(): DiscordApprovalsClient & {
  fire: (i: DiscordButtonInteraction) => void;
} {
  const handlers: ((i: DiscordButtonInteraction) => void)[] = [];
  return {
    on(_event, handler) { handlers.push(handler); },
    off(_event, handler) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    },
    fire(i) { for (const h of handlers) h(i); },
  };
}

function makeChannel(): DiscordApprovalChannel & {
  sent: { content?: string; embeds?: unknown[]; components?: unknown[] }[];
} {
  const sent: { content?: string; embeds?: unknown[]; components?: unknown[] }[] = [];
  return {
    sent,
    async send(payload) {
      sent.push(payload);
      const msg: DiscordApprovalMessage = {
        id: `msg-${sent.length}`,
        edit: vi.fn(async () => {}),
      };
      return msg;
    },
  };
}

function makeInteraction(customId: string, overrides: Partial<DiscordButtonInteraction> = {}): DiscordButtonInteraction {
  return {
    customId,
    user: { id: 'user-1', username: 'tester' },
    member: null,
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    ...overrides,
  };
}

async function publishApproval(transport: FakeTransport, request: ApprovalRequest): Promise<MessageEnvelope> {
  return transport.request('handraise.human.default' as TopicString, {
    question: `Approve: ${request.command}`,
    context: request,
    callId: 'call-1',
  }, { timeoutMs: 2000 });
}

describe('bridgeDiscordApprovals', () => {
  it('posts a 4-button embed when an approval lands in the inbox', async () => {
    const transport = new FakeTransport();
    const inbox = new HandraiseInbox({ transport, channels: ['default'] });
    inbox.start();
    const client = makeFakeClient();
    const channel = makeChannel();
    bridgeDiscordApprovals({
      client,
      inbox,
      resolveChannel: async () => channel,
    });

    // We don't await the request — it stays open until a click resolves it.
    const replyPromise = publishApproval(transport, {
      kind: 'approval',
      approvalKey: 'k',
      command: 'rm -rf /tmp/x',
      reason: 'cleanup',
      sessionKey: 'agent:main:discord:channel:ch-1:user-7',
      channelId: 'ch-1',
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(channel.sent).toHaveLength(1);
    const row = (channel.sent[0].components as { components: { custom_id: string; label: string }[] }[])[0];
    expect(row.components).toHaveLength(4);
    expect(row.components.map((c) => c.label)).toEqual([
      'Allow Once',
      'Allow Session',
      'Always Allow',
      'Deny',
    ]);

    // Click "Allow Once" — extract the customId from the rendered button.
    const customId = row.components[0].custom_id;
    expect(customId.startsWith('nexora_approval:')).toBe(true);
    client.fire(makeInteraction(customId));

    const reply = await replyPromise;
    const ans = (reply.payload as { answer: ApprovalReply }).answer;
    expect(ans.choice).toBe('once');
    expect(ans.displayName).toBe('tester');
    inbox.stop();
  });

  it('rejects unauthorized clicks with an ephemeral reply', async () => {
    const transport = new FakeTransport();
    const inbox = new HandraiseInbox({ transport, channels: ['default'] });
    inbox.start();
    const client = makeFakeClient();
    const channel = makeChannel();
    bridgeDiscordApprovals({ client, inbox, resolveChannel: async () => channel });

    const replyPromise = publishApproval(transport, {
      kind: 'approval',
      approvalKey: 'k',
      command: 'rm',
      reason: 'r',
      sessionKey: 'agent:main:discord:channel:ch-1',
      channelId: 'ch-1',
      allowedUsers: ['boss-only'],
    });
    await new Promise((r) => setTimeout(r, 10));

    const row = (channel.sent[0].components as { components: { custom_id: string }[] }[])[0];
    const interaction = makeInteraction(row.components[0].custom_id);
    client.fire(interaction);
    await new Promise((r) => setTimeout(r, 10));

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    // The pending request is still unresolved.
    let resolved = false;
    void replyPromise.then(() => { resolved = true; }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // An authorized user clicks → resolves.
    client.fire(makeInteraction(row.components[3].custom_id, {
      user: { id: 'boss-only', username: 'boss' },
    }));
    const reply = await replyPromise;
    const ans = (reply.payload as { answer: ApprovalReply }).answer;
    expect(ans.choice).toBe('deny');
    inbox.stop();
  });

  it('enforces role-based authorization when allowedRoles is set', async () => {
    const transport = new FakeTransport();
    const inbox = new HandraiseInbox({ transport, channels: ['default'] });
    inbox.start();
    const client = makeFakeClient();
    const channel = makeChannel();
    bridgeDiscordApprovals({ client, inbox, resolveChannel: async () => channel });

    const replyPromise = publishApproval(transport, {
      kind: 'approval',
      approvalKey: 'k',
      command: 'rm',
      reason: 'r',
      sessionKey: 'agent:main:discord:channel:ch-1',
      channelId: 'ch-1',
      allowedRoles: ['role-mod'],
    });
    await new Promise((r) => setTimeout(r, 10));

    const row = (channel.sent[0].components as { components: { custom_id: string }[] }[])[0];

    // Click without the role — rejected.
    const interaction = makeInteraction(row.components[0].custom_id, {
      member: { roleIds: ['role-other'] },
    });
    client.fire(interaction);
    await new Promise((r) => setTimeout(r, 5));
    expect(interaction.reply).toHaveBeenCalled();

    // Click with the role — accepted.
    client.fire(makeInteraction(row.components[0].custom_id, {
      member: { roleIds: ['role-other', 'role-mod'] },
      user: { id: 'mod-1', username: 'mod' },
    }));
    const reply = await replyPromise;
    expect((reply.payload as { answer: ApprovalReply }).answer.choice).toBe('once');
    inbox.stop();
  });

  it('ignores non-approval pending entries', async () => {
    const transport = new FakeTransport();
    const inbox = new HandraiseInbox({ transport, channels: ['default'] });
    inbox.start();
    const client = makeFakeClient();
    const channel = makeChannel();
    bridgeDiscordApprovals({ client, inbox, resolveChannel: async () => channel });

    // Publish a normal handraise (no approval context) — bridge should not post.
    void transport.publish({
      id: messageId(),
      topic: 'handraise.human.default' as TopicString,
      type: 'request',
      payload: { question: 'plain question', callId: 'c1' },
      metadata: {
        traceId: 't', spanId: 's', conversationId: 'c',
        tenantId: 'tenant-A', timestamp: Date.now(),
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(channel.sent).toHaveLength(0);
    inbox.stop();
  });

  it('routes the prompt into the threadId when one is present', async () => {
    const transport = new FakeTransport();
    const inbox = new HandraiseInbox({ transport, channels: ['default'] });
    inbox.start();
    const client = makeFakeClient();
    const resolveChannel = vi.fn(async (id: string) => makeChannel());

    bridgeDiscordApprovals({ client, inbox, resolveChannel });

    void publishApproval(transport, {
      kind: 'approval',
      approvalKey: 'k',
      command: 'rm',
      reason: 'r',
      sessionKey: 'agent:main:discord:channel:ch-1:th-9',
      channelId: 'ch-1',
      threadId: 'th-9',
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(resolveChannel).toHaveBeenCalledWith('th-9');
    inbox.stop();
  });
});
