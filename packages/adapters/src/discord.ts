/**
 * DiscordAdapter — connects Nexora to Discord via discord.js.
 *
 * Implements the Adapter interface: Discord messages → InboundMessage →
 * MessageRouter → OutboundChunk → Discord reply.
 *
 * SDK independence: discord.js is NOT a dependency of @nexora/adapters.
 * Instead, the caller passes a `DiscordClientLike` interface. This keeps
 * the package light and lets users pin their own discord.js version.
 *
 * Usage:
 *   import { Client, GatewayIntentBits } from 'discord.js';
 *   import { DiscordAdapter } from '@nexora/adapters';
 *
 *   const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
 *   await client.login(process.env.DISCORD_TOKEN);
 *
 *   const adapter = new DiscordAdapter({ client, resolveTenant: (guildId) => guildId });
 *   await adapter.start(router);
 *
 * Features:
 *   - Maps Discord messages to InboundMessage (platform, channelId, userId, tenantId)
 *   - Streams agent responses back as Discord messages (chunked for 2000 char limit)
 *   - Supports @mention routing (extracts mentioned agent name)
 *   - Ignores bot messages to prevent loops
 *   - Typing indicator while agent is processing
 */

import type {
  Adapter,
  MessageRouter,
  InboundMessage,
  OutboundChunk,
} from '@nexora/contracts';

// ─── Minimal discord.js interface (SDK-independent) ────────────────────────

export interface DiscordMessageLike {
  id: string;
  content: string;
  author: { id: string; username: string; bot: boolean };
  channelId: string;
  guildId: string | null;
  mentions: { users: Map<string, { id: string; username: string }> };
  reply: (content: string) => Promise<unknown>;
  channel: {
    sendTyping: () => Promise<unknown>;
    send: (content: string) => Promise<unknown>;
  };
}

export interface DiscordClientLike {
  on(event: 'messageCreate', handler: (message: DiscordMessageLike) => void): void;
  off(event: 'messageCreate', handler: (message: DiscordMessageLike) => void): void;
  user?: { id: string } | null;
}

export interface DiscordAdapterOptions {
  /** Pre-authenticated discord.js Client instance. */
  client: DiscordClientLike;
  /**
   * Resolve tenantId from a Discord guild (server) ID. Default: use guildId
   * as tenantId. Return null to ignore messages from that guild.
   */
  resolveTenant?: (guildId: string | null) => string | null;
  /** Max chars per Discord message (default 1900, below Discord's 2000 limit). */
  maxMessageLength?: number;
  /**
   * Map of bot user IDs → agent names for @mention routing.
   * When a user @mentions a bot, the message is routed to that agent's topic.
   * If not provided, all mentions are ignored and messages go to the default topic.
   */
  agentBotMap?: ReadonlyMap<string, string>;
  /**
   * Agent descriptions for the !agents discovery command.
   * Map of agent name → description. If set, the adapter responds to
   * "!agents" with a list of available agents.
   */
  agentDescriptions?: ReadonlyMap<string, string>;
}

const DEFAULT_MAX_MESSAGE_LENGTH = 1900;

export class DiscordAdapter implements Adapter {
  readonly name = 'discord';
  private readonly client: DiscordClientLike;
  private readonly resolveTenant: NonNullable<DiscordAdapterOptions['resolveTenant']>;
  private readonly maxLen: number;
  private readonly agentBotMap: ReadonlyMap<string, string>;
  private readonly agentDescriptions: ReadonlyMap<string, string>;
  private handler: ((msg: DiscordMessageLike) => void) | null = null;

  constructor(options: DiscordAdapterOptions) {
    this.client = options.client;
    this.resolveTenant = options.resolveTenant ?? ((guildId) => guildId ?? 'dm');
    this.maxLen = options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
    this.agentBotMap = options.agentBotMap ?? new Map();
    this.agentDescriptions = options.agentDescriptions ?? new Map();
  }

  async start(router: MessageRouter): Promise<void> {
    if (this.handler) throw new Error('DiscordAdapter already started');

    const botId = this.client.user?.id;

    this.handler = (message: DiscordMessageLike) => {
      // Ignore bot messages (prevents infinite loops).
      if (message.author.bot) return;
      // Ignore empty messages.
      if (!message.content.trim()) return;

      const tenantId = this.resolveTenant(message.guildId);
      if (tenantId === null) return; // guild not configured

      // Discovery command: !agents
      if (message.content.trim() === '!agents' && this.agentDescriptions.size > 0) {
        const lines = ['**Available Agents:**'];
        for (const [name, desc] of this.agentDescriptions) {
          lines.push(`• **${name}** — ${desc}`);
        }
        void message.reply(lines.join('\n')).catch(() => {});
        return;
      }

      // Extract mentioned agent name from @mentions
      let mentionedAgent: string | undefined;
      if (this.agentBotMap.size > 0) {
        for (const [userId] of message.mentions.users) {
          const agentName = this.agentBotMap.get(userId);
          if (agentName) {
            mentionedAgent = agentName;
            break;
          }
        }
      }

      const inbound: InboundMessage = {
        platform: 'discord',
        channelId: message.channelId,
        userId: message.author.id,
        displayName: message.author.username,
        content: message.content,
        tenantId,
        conversationId: message.channelId, // Discord channel = conversation
        // Pass mentioned agent name for IntentResolver to use
        ...(mentionedAgent ? { metadata: { mentionedAgent } } : {}),
      };

      // Fire and forget — we don't want to block the Discord event loop.
      void this.processMessage(router, inbound, message);
    };

    this.client.on('messageCreate', this.handler);
  }

  async stop(): Promise<void> {
    if (this.handler) {
      this.client.off('messageCreate', this.handler);
      this.handler = null;
    }
  }

  private async processMessage(
    router: MessageRouter,
    inbound: InboundMessage,
    discordMsg: DiscordMessageLike,
  ): Promise<void> {
    // Show typing indicator while processing.
    try {
      await discordMsg.channel.sendTyping();
    } catch {
      // Some channels don't allow typing — ignore.
    }

    try {
      // Use streaming if the router supports it, so we can send incremental
      // messages. If the response is short enough, routeStream will call
      // onChunk with type='done' immediately.
      const chunks: string[] = [];

      await router.routeStream(inbound, (chunk: OutboundChunk) => {
        if (chunk.type === 'text') {
          chunks.push(chunk.text);
        } else if (chunk.type === 'tool_call') {
          // Optionally show tool usage as a subtle indicator
          chunks.push(`_Using ${chunk.name}..._`);
        } else if (chunk.type === 'error') {
          chunks.push(`**Error:** ${chunk.message}`);
        }
        // 'done', 'thinking', 'tool_result' are silent in Discord output.
      });

      const fullResponse = chunks.join('');

      if (!fullResponse.trim()) {
        await discordMsg.reply('_(no response)_');
        return;
      }

      // Split long responses to respect Discord's 2000 char limit.
      await this.sendChunked(discordMsg, fullResponse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await discordMsg.reply(`**Error:** ${msg.slice(0, 200)}`);
      } catch {
        // Can't even reply — give up silently.
      }
    }
  }

  private async sendChunked(
    discordMsg: DiscordMessageLike,
    text: string,
  ): Promise<void> {
    // First chunk → reply (creates a thread-like visual). Rest → channel.send.
    const parts = splitMessage(text, this.maxLen);
    let first = true;
    for (const part of parts) {
      if (first) {
        await discordMsg.reply(part);
        first = false;
      } else {
        await discordMsg.channel.send(part);
      }
    }
  }
}

/**
 * Split a long string into chunks that fit Discord's character limit.
 * Tries to split on newlines or spaces to avoid mid-word breaks.
 */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }

    // Try to split at a newline near the end of the chunk.
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.5) {
      // No good newline — try space.
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // No good split point — hard split.
      splitIdx = maxLen;
    }

    parts.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return parts;
}
