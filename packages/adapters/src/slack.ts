/**
 * SlackAdapter — connects Nexora to Slack via Bolt-compatible interface.
 *
 * SDK-independent: pass a SlackClientLike interface. No @slack/bolt dependency.
 * The caller creates the Slack app/client and passes the minimum surface area.
 *
 * Usage:
 *   import { App } from '@slack/bolt';
 *   import { SlackAdapter } from '@nexora/adapters';
 *
 *   const app = new App({ token: '...', signingSecret: '...' });
 *   const adapter = new SlackAdapter({
 *     client: {
 *       onMessage: (handler) => app.message(async ({ message, say }) => handler(message, say)),
 *       postMessage: (channel, text) => app.client.chat.postMessage({ channel, text }),
 *     },
 *     resolveTenant: (teamId) => teamId,
 *   });
 *   await adapter.start(router);
 *   await app.start(3000);
 */

import type {
  Adapter,
  MessageRouter,
  InboundMessage,
  OutboundChunk,
} from '@nexora/contracts';

export interface SlackMessageEvent {
  text: string;
  user: string;
  channel: string;
  team?: string;
  ts: string;
  bot_id?: string;
  thread_ts?: string;
}

export interface SlackClientLike {
  /** Register a message handler. Called for every new message in subscribed channels. */
  onMessage(handler: (event: SlackMessageEvent, say: (text: string) => Promise<void>) => Promise<void>): void;
  /** Post a message to a channel. */
  postMessage(channel: string, text: string, threadTs?: string): Promise<void>;
}

export interface SlackAdapterOptions {
  client: SlackClientLike;
  /** Map Slack team (workspace) ID to Nexora tenant ID. Default: use teamId. */
  resolveTenant?: (teamId: string | undefined) => string | null;
  /** Max chars per Slack message (default 3900, below Slack's 4000 limit). */
  maxMessageLength?: number;
}

const DEFAULT_MAX_MESSAGE_LENGTH = 3900;

export class SlackAdapter implements Adapter {
  readonly name = 'slack';
  private readonly client: SlackClientLike;
  private readonly resolveTenant: NonNullable<SlackAdapterOptions['resolveTenant']>;
  private readonly maxLen: number;
  private started = false;

  constructor(options: SlackAdapterOptions) {
    this.client = options.client;
    this.resolveTenant = options.resolveTenant ?? ((teamId) => teamId ?? 'default');
    this.maxLen = options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
  }

  async start(router: MessageRouter): Promise<void> {
    if (this.started) throw new Error('SlackAdapter already started');
    this.started = true;

    this.client.onMessage(async (event, say) => {
      // Ignore bot messages
      if (event.bot_id) return;
      if (!event.text?.trim()) return;

      const tenantId = this.resolveTenant(event.team);
      if (tenantId === null) return;

      const inbound: InboundMessage = {
        platform: 'slack',
        channelId: event.channel,
        userId: event.user,
        displayName: event.user, // Slack doesn't give display name in message events
        content: event.text,
        tenantId,
        conversationId: event.thread_ts ?? event.ts, // thread = conversation
      };

      try {
        const chunks: string[] = [];

        await router.routeStream(inbound, (chunk: OutboundChunk) => {
          if (chunk.type === 'text') chunks.push(chunk.text);
          else if (chunk.type === 'tool_call') chunks.push(`_Using ${chunk.name}..._`);
          else if (chunk.type === 'error') chunks.push(`*Error:* ${chunk.message}`);
        });

        const fullResponse = chunks.join('');
        if (!fullResponse.trim()) {
          await say('_(no response)_');
          return;
        }

        // Split for Slack's 4000 char limit
        const parts = splitMessage(fullResponse, this.maxLen);
        for (const part of parts) {
          await say(part);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          await say(`*Error:* ${msg.slice(0, 200)}`);
        } catch {
          // Can't reply — give up
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.started = false;
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { parts.push(remaining); break; }
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = remaining.lastIndexOf(' ', maxLen);
    if (splitIdx < maxLen * 0.3) splitIdx = maxLen;
    parts.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return parts;
}
