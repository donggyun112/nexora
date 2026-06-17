/**
 * DiscordAdapter — connects Nexora to Discord via discord.js.
 *
 * Implements the Adapter interface: Discord messages → InboundMessage →
 * MessageRouter → OutboundChunk → Discord reply.
 *
 * SDK independence: discord.js is NOT a dependency of @dongkseo/adapters.
 * Instead, the caller passes a `DiscordClientLike` interface. This keeps
 * the package light and lets users pin their own discord.js version.
 *
 * Usage:
 *   import { Client, GatewayIntentBits } from 'discord.js';
 *   import { DiscordAdapter } from '@dongkseo/adapters';
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
 *   - Channel / user / role allowlists for multi-tenant deployments
 *   - Hermes-style session-key isolation (DM, group, thread rules)
 */

import type {
  Adapter,
  MessageRouter,
  InboundMessage,
  OutboundChunk,
  OutboundArtifact,
} from '@dongkseo/contracts';
import {
  buildSessionKey,
  type ChatType,
  type SessionKeyOptions,
} from './session-key.js';
import {
  createStatusReactionController,
  type StatusReactionController,
  type StatusReactionOptions,
} from './discord-reactions.js';

// ─── Minimal discord.js interface (SDK-independent) ────────────────────────

export interface DiscordMessageLike {
  id: string;
  content: string;
  author: { id: string; username: string; bot: boolean };
  channelId: string;
  guildId: string | null;
  mentions: { users: Map<string, { id: string; username: string; bot?: boolean }> };
  attachments?: { size: number; keys?: () => Iterable<string> };
  reply: (content: DiscordSendPayload) => Promise<unknown>;
  channel: {
    sendTyping: () => Promise<unknown>;
    send: (content: DiscordSendPayload) => Promise<unknown>;
    /** discord.js exposes channel.isThread() — we treat it as optional/dynamic. */
    isThread?: () => boolean;
    /** For thread channels, the parent channel id (the "real" room). */
    parentId?: string | null;
  };
  /**
   * Guild member info. Absent in DMs. `roleIds` is the role ID list — most
   * discord.js wrappers expose `message.member.roles.cache.keys()`; callers
   * should flatten that to a string array before passing it in.
   */
  member?: { roleIds: ReadonlyArray<string> } | null;
  /**
   * Add an emoji reaction to this message. Optional — when present, the
   * adapter drives a per-turn `StatusReactionController` so users see
   * thinking/tool/done/error emojis. discord.js exposes `Message#react`
   * directly; just forward to it.
   */
  react?: (emoji: string) => Promise<unknown>;
  /**
   * Remove THIS bot's own reaction for the given emoji. Optional. In
   * discord.js this is `message.reactions.cache.get(emoji)?.users.remove(botId)`.
   * Without this, the controller will leave older emojis in place when
   * transitioning between phases.
   */
  removeOwnReaction?: (emoji: string) => Promise<unknown>;
}

export type DiscordSendPayload = string | DiscordMessagePayload;

export interface DiscordMessagePayload {
  content?: string;
  files?: Array<{ attachment: Buffer; name: string }>;
  embeds?: Array<{
    title?: string;
    description?: string;
    color?: number;
    image?: { url: string };
  }>;
  allowedMentions?: { parse: string[] };
}

export interface DiscordClientLike {
  on(event: 'messageCreate', handler: (message: DiscordMessageLike) => void): void;
  off(event: 'messageCreate', handler: (message: DiscordMessageLike) => void): void;
  user?: { id: string } | null;
}

export type DiscordBotMessagePolicy = 'none' | 'mentions' | 'all';

export interface DiscordAdapterOptions extends SessionKeyOptions {
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

  // ─── ACL ─────────────────────────────────────────────────────────────────
  /**
   * If set, only channels in this list are processed (whitelist). Applied to
   * the originating channelId — threads inherit from their parent if the
   * parent is allowed.
   */
  allowedChannels?: ReadonlyArray<string>;
  /** If set, channels in this list are always dropped (blacklist). */
  ignoredChannels?: ReadonlyArray<string>;
  /** If set, only users in this list are processed. */
  allowedUsers?: ReadonlyArray<string>;
  /**
   * If set, the author must have at least one of these role IDs. DMs (no
   * member info) are dropped when this is configured unless `allowDmForRoles`
   * is true.
   */
  allowedRoles?: ReadonlyArray<string>;
  /** When `allowedRoles` is set, also accept DMs (default false). */
  allowDmForRoles?: boolean;
  /**
   * Require @mention of this bot or a configured agent bot in server channels.
   * DMs always bypass this gate. Default: false, preserving the historical
   * Nexora behavior of responding to all allowed channel messages.
   */
  requireMention?: boolean;
  /**
   * Channels where the bot replies even without an @mention when
   * `requireMention` is enabled. Threads inherit from their parent channel.
   * Use "*" to allow all channels.
   */
  freeResponseChannels?: ReadonlyArray<string>;
  /**
   * If false, a thread where the adapter has already handled a message can keep
   * the conversation going without repeated @mentions. Default: false.
   */
  threadRequireMention?: boolean;
  /**
   * Whether messages authored by other bots are processed.
   * - "none": ignore all bot-authored messages (default)
   * - "mentions": accept bot messages only when they mention this bot/agent
   * - "all": accept all bot messages except this client itself
   */
  allowBots?: DiscordBotMessagePolicy;
  /**
   * Drop messages that explicitly mention another bot but not this bot or a
   * configured agent bot. This prevents multi-bot cross-talk when mention data
   * includes `bot: true`. Default: true.
   */
  ignoreOtherBotMentions?: boolean;
  /**
   * Optional hook for unauthorized access attempts (admin notification).
   * Receives the rejected message and a short reason string.
   */
  onUnauthorized?: (message: DiscordMessageLike, reason: string) => void;

  /**
   * Status reaction config. When the inbound `DiscordMessageLike` exposes a
   * `react` method, the adapter attaches a per-turn reaction controller that
   * shows 🧠 thinking → 🛠️ tool → ✅ done / ❌ error on the user's message.
   * Pass `false` to disable, or an options object to customize emoji and
   * stall thresholds. Defaults: enabled.
   */
  statusReactions?: boolean | StatusReactionOptions;
  /**
   * Debounce rapid same channel/user messages into one router turn.
   * Defaults to 1500ms. Set to 0 to disable.
   */
  messageDebounceMs?: number;
}

const DEFAULT_MAX_MESSAGE_LENGTH = 1900;
const DEFAULT_MESSAGE_DEBOUNCE_MS = 1500;
const MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000;
const MESSAGE_DEDUP_MAX_ENTRIES = 5000;

interface PendingDiscordTurn {
  message: DiscordMessageLike;
  inbound: InboundMessage;
}

interface DebounceBuffer {
  items: PendingDiscordTurn[];
  timeout: ReturnType<typeof setTimeout> | null;
}

export class DiscordAdapter implements Adapter {
  readonly name = 'discord';
  private readonly client: DiscordClientLike;
  private readonly resolveTenant: NonNullable<DiscordAdapterOptions['resolveTenant']>;
  private readonly maxLen: number;
  private readonly agentBotMap: ReadonlyMap<string, string>;
  private readonly agentDescriptions: ReadonlyMap<string, string>;
  private readonly sessionOptions: SessionKeyOptions;
  private readonly allowedChannels: ReadonlySet<string> | null;
  private readonly ignoredChannels: ReadonlySet<string>;
  private readonly allowedUsers: ReadonlySet<string> | null;
  private readonly allowedRoles: ReadonlySet<string> | null;
  private readonly allowDmForRoles: boolean;
  private readonly requireMention: boolean;
  private readonly freeResponseChannels: ReadonlySet<string>;
  private readonly threadRequireMention: boolean;
  private readonly allowBots: DiscordBotMessagePolicy;
  private readonly ignoreOtherBotMentions: boolean;
  private readonly onUnauthorized: NonNullable<DiscordAdapterOptions['onUnauthorized']> | null;
  private readonly statusReactionOptions: StatusReactionOptions | null;
  private readonly messageDebounceMs: number;
  private handler: ((msg: DiscordMessageLike) => void) | null = null;
  private readonly seenMessages = new Map<string, { fingerprint: string; seenAt: number }>();
  private readonly debounceBuffers = new Map<string, DebounceBuffer>();
  private readonly channelRuns = new Map<string, Promise<void>>();
  private readonly participatedThreads = new Set<string>();

  constructor(options: DiscordAdapterOptions) {
    this.client = options.client;
    this.resolveTenant = options.resolveTenant ?? ((guildId) => guildId ?? 'dm');
    this.maxLen = options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
    this.agentBotMap = options.agentBotMap ?? new Map();
    this.agentDescriptions = options.agentDescriptions ?? new Map();
    this.sessionOptions = {
      groupSessionsPerUser: options.groupSessionsPerUser,
      threadSessionsPerUser: options.threadSessionsPerUser,
      namespace: options.namespace,
    };
    this.allowedChannels = options.allowedChannels
      ? new Set(options.allowedChannels)
      : null;
    this.ignoredChannels = new Set(options.ignoredChannels ?? []);
    this.allowedUsers = options.allowedUsers ? new Set(options.allowedUsers) : null;
    this.allowedRoles = options.allowedRoles ? new Set(options.allowedRoles) : null;
    this.allowDmForRoles = options.allowDmForRoles ?? false;
    this.requireMention = options.requireMention ?? false;
    this.freeResponseChannels = new Set(options.freeResponseChannels ?? []);
    this.threadRequireMention = options.threadRequireMention ?? false;
    this.allowBots = options.allowBots ?? 'none';
    this.ignoreOtherBotMentions = options.ignoreOtherBotMentions ?? true;
    this.onUnauthorized = options.onUnauthorized ?? null;

    const sr = options.statusReactions;
    if (sr === false) {
      this.statusReactionOptions = null;
    } else if (sr === true || sr === undefined) {
      this.statusReactionOptions = {};
    } else {
      this.statusReactionOptions = sr;
    }
    this.messageDebounceMs = Math.max(
      0,
      Math.trunc(options.messageDebounceMs ?? DEFAULT_MESSAGE_DEBOUNCE_MS),
    );
  }

  async start(router: MessageRouter): Promise<void> {
    if (this.handler) throw new Error('DiscordAdapter already started');

    this.handler = (message: DiscordMessageLike) => {
      if (this.shouldDropBotAuthoredMessage(message)) return;
      if (this.isDuplicateMessageEvent(message)) return;
      // Ignore empty messages.
      if (!message.content.trim()) return;

      const tenantId = this.resolveTenant(message.guildId);
      if (tenantId === null) return; // guild not configured

      const reject = this.checkAcl(message);
      if (reject) {
        this.onUnauthorized?.(message, reject);
        return;
      }

      const chatType: ChatType = message.guildId ? 'channel' : 'dm';
      const isThread = Boolean(message.channel.isThread?.());
      const threadId = isThread ? message.channelId : null;
      const parentChannelId = isThread
        ? message.channel.parentId ?? message.channelId
        : message.channelId;

      const mentionedAgent = this.findMentionedAgent(message);
      const selfMentioned = this.isSelfMentioned(message);
      const sessionKey = buildSessionKey(
        {
          platform: 'discord',
          chatType,
          chatId: parentChannelId,
          threadId,
          userId: message.author.id,
        },
        this.sessionOptions,
      );

      const freeResponse =
        channelSetMatches(this.freeResponseChannels, message.channelId, parentChannelId);

      if (this.hasOtherBotMention(message)) return;
      if (!this.passesMentionGate({
        message,
        isThread,
        threadId,
        mentionedAgent,
        selfMentioned,
        freeResponse,
      })) {
        return;
      }

      // Discovery command: !agents
      if (message.content.trim() === '!agents' && this.agentDescriptions.size > 0) {
        const lines = ['**Available Agents:**'];
        for (const [name, desc] of this.agentDescriptions) {
          lines.push(`• **${name}** — ${desc}`);
        }
        void message.reply(lines.join('\n')).catch(() => {});
        return;
      }

      const metadata: Record<string, unknown> = {};
      if (mentionedAgent) metadata.mentionedAgent = mentionedAgent;
      if (threadId) metadata.threadId = threadId;
      if (parentChannelId !== message.channelId) metadata.parentChannelId = parentChannelId;
      if (freeResponse) metadata.freeResponse = true;
      if (selfMentioned) metadata.mentionedSelf = true;

      const inbound: InboundMessage = {
        platform: 'discord',
        channelId: message.channelId,
        userId: message.author.id,
        displayName: message.author.username,
        content: message.content,
        tenantId,
        conversationId: sessionKey,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      };

      // Fire and forget — we don't want to block the Discord event loop.
      if (threadId) this.participatedThreads.add(threadId);
      void this.enqueueMessage(router, { message, inbound });
    };

    this.client.on('messageCreate', this.handler);
  }

  async stop(): Promise<void> {
    if (this.handler) {
      this.client.off('messageCreate', this.handler);
      this.handler = null;
    }
    this.clearDebounceBuffers();
    this.channelRuns.clear();
    this.seenMessages.clear();
    this.participatedThreads.clear();
  }

  /**
   * Run channel / user / role allowlists. Returns a short reason string when
   * the message should be rejected, or null when it is allowed.
   */
  private checkAcl(message: DiscordMessageLike): string | null {
    const channelId = message.channelId;
    const parentId = message.channel.parentId ?? null;

    if (channelSetMatches(this.ignoredChannels, channelId, parentId)) {
      return parentId && this.ignoredChannels.has(parentId)
        ? 'parent channel ignored'
        : 'channel ignored';
    }

    if (this.allowedChannels) {
      const channelOk = channelSetMatches(this.allowedChannels, channelId, parentId);
      if (!channelOk) return 'channel not in allowlist';
    }

    if (this.allowedUsers && !this.allowedUsers.has(message.author.id)) {
      return 'user not in allowlist';
    }

    if (this.allowedRoles) {
      const isDm = !message.guildId;
      if (isDm) {
        if (!this.allowDmForRoles) return 'dm not allowed with role gate';
      } else {
        const roleIds = message.member?.roleIds ?? [];
        const hasRole = roleIds.some((id) => this.allowedRoles!.has(id));
        if (!hasRole) return 'user lacks required role';
      }
    }

    return null;
  }

  private shouldDropBotAuthoredMessage(message: DiscordMessageLike): boolean {
    if (!message.author.bot) return false;
    if (this.client.user?.id && message.author.id === this.client.user.id) return true;
    if (this.allowBots === 'all') return false;
    if (this.allowBots === 'mentions') {
      return !this.isSelfMentioned(message) && !this.findMentionedAgent(message);
    }
    return true;
  }

  private findMentionedAgent(message: DiscordMessageLike): string | undefined {
    if (this.agentBotMap.size === 0) return undefined;
    for (const [userId, user] of message.mentions.users) {
      const agentName = this.agentBotMap.get(userId) ?? this.agentBotMap.get(user.id);
      if (agentName) return agentName;
    }
    return undefined;
  }

  private isSelfMentioned(message: DiscordMessageLike): boolean {
    const selfId = this.client.user?.id;
    return Boolean(selfId && mentionIncludesUser(message, selfId));
  }

  private hasOtherBotMention(message: DiscordMessageLike): boolean {
    if (!this.ignoreOtherBotMentions) return false;
    if (this.isSelfMentioned(message) || this.findMentionedAgent(message)) return false;
    const selfId = this.client.user?.id ?? null;
    for (const [userId, user] of message.mentions.users) {
      const mentionedId = user.id || userId;
      if (!user.bot) continue;
      if (mentionedId === selfId) continue;
      if (this.agentBotMap.has(mentionedId)) continue;
      return true;
    }
    return false;
  }

  private passesMentionGate(args: {
    message: DiscordMessageLike;
    isThread: boolean;
    threadId: string | null;
    mentionedAgent: string | undefined;
    selfMentioned: boolean;
    freeResponse: boolean;
  }): boolean {
    if (!args.message.guildId) return true;
    if (!this.requireMention) return true;
    if (args.freeResponse) return true;
    if (args.selfMentioned || args.mentionedAgent) return true;
    if (
      args.isThread &&
      args.threadId &&
      !this.threadRequireMention &&
      this.participatedThreads.has(args.threadId)
    ) {
      return true;
    }
    return false;
  }

  private isDuplicateMessageEvent(message: DiscordMessageLike): boolean {
    const now = Date.now();

    for (const [id, entry] of this.seenMessages) {
      if (now - entry.seenAt > MESSAGE_DEDUP_TTL_MS) {
        this.seenMessages.delete(id);
      }
    }

    const fingerprint = buildMessageFingerprint(message);
    const prev = this.seenMessages.get(message.id);
    if (prev && prev.fingerprint === fingerprint) {
      prev.seenAt = now;
      return true;
    }

    this.seenMessages.set(message.id, { fingerprint, seenAt: now });

    if (this.seenMessages.size > MESSAGE_DEDUP_MAX_ENTRIES) {
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, entry] of this.seenMessages) {
        if (entry.seenAt < oldestAt) {
          oldestAt = entry.seenAt;
          oldestId = id;
        }
      }
      if (oldestId) this.seenMessages.delete(oldestId);
    }

    return false;
  }

  private enqueueMessage(router: MessageRouter, turn: PendingDiscordTurn): Promise<void> {
    const key = this.debounceKey(turn.message);
    const canDebounce = this.messageDebounceMs > 0 && !hasAttachments(turn.message);

    if (!canDebounce) {
      return this.flushDebounceBuffer(router, key).then(() =>
        this.enqueueChannelRun(turn.message.channelId, () =>
          this.processMessage(router, turn.inbound, turn.message),
        ),
      );
    }

    const existing = this.debounceBuffers.get(key);
    if (existing) {
      existing.items.push(turn);
      this.scheduleDebounceFlush(router, key, existing);
      return Promise.resolve();
    }

    const buffer: DebounceBuffer = { items: [turn], timeout: null };
    this.debounceBuffers.set(key, buffer);
    this.scheduleDebounceFlush(router, key, buffer);
    return Promise.resolve();
  }

  private debounceKey(message: DiscordMessageLike): string {
    return `${message.channelId}:${message.author.id}`;
  }

  private scheduleDebounceFlush(
    router: MessageRouter,
    key: string,
    buffer: DebounceBuffer,
  ): void {
    if (buffer.timeout) clearTimeout(buffer.timeout);
    buffer.timeout = setTimeout(() => {
      void this.flushDebounceBuffer(router, key);
    }, this.messageDebounceMs);
    buffer.timeout.unref?.();
  }

  private async flushDebounceBuffer(router: MessageRouter, key: string): Promise<void> {
    const buffer = this.debounceBuffers.get(key);
    if (!buffer) return;
    this.debounceBuffers.delete(key);
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    if (buffer.items.length === 0) return;

    const anchor = buffer.items[buffer.items.length - 1];
    const content = buffer.items
      .map((item) => item.inbound.content.trim())
      .filter(Boolean)
      .join('\n');
    if (!content) return;

    await this.enqueueChannelRun(anchor.message.channelId, () =>
      this.processMessage(router, { ...anchor.inbound, content }, anchor.message),
    );
  }

  private enqueueChannelRun(channelId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.channelRuns.get(channelId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (this.channelRuns.get(channelId) === next) {
          this.channelRuns.delete(channelId);
        }
      });
    this.channelRuns.set(channelId, next);
    return next;
  }

  private clearDebounceBuffers(): void {
    for (const buffer of this.debounceBuffers.values()) {
      if (buffer.timeout) clearTimeout(buffer.timeout);
    }
    this.debounceBuffers.clear();
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

    const status = this.createStatusController(discordMsg);
    status?.setThinking();

    let sawError = false;
    try {
      // Use streaming if the router supports it, so we can send incremental
      // messages. If the response is short enough, routeStream will call
      // onChunk with type='done' immediately.
      const chunks: Array<string | DiscordMessagePayload> = [];

      await router.routeStream(inbound, (chunk: OutboundChunk) => {
        if (chunk.type === 'text') {
          chunks.push(chunk.text);
        } else if (chunk.type === 'artifact') {
          chunks.push(...renderDiscordArtifactMessages(chunk.artifact));
        } else if (chunk.type === 'tool_call') {
          // Optionally show tool usage as a subtle indicator
          chunks.push(`_Using ${chunk.name}..._`);
          status?.setTool(chunk.name);
        } else if (chunk.type === 'thinking') {
          status?.setThinking();
        } else if (chunk.type === 'error') {
          chunks.push(`**Error:** ${chunk.message}`);
          sawError = true;
        }
        // 'done', 'tool_result' are silent in Discord output.
      });

      if (!hasResponseContent(chunks)) {
        await discordMsg.reply('_(no response)_');
        await (sawError ? status?.setError() : status?.setDone());
        return;
      }

      // Split long responses to respect Discord's 2000 char limit.
      await this.sendResponseParts(discordMsg, chunks);
      await (sawError ? status?.setError() : status?.setDone());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await discordMsg.reply(`**Error:** ${msg.slice(0, 200)}`);
      } catch {
        // Can't even reply — give up silently.
      }
      await status?.setError();
    }
  }

  private createStatusController(
    discordMsg: DiscordMessageLike,
  ): StatusReactionController | null {
    if (!this.statusReactionOptions || typeof discordMsg.react !== 'function') {
      return null;
    }
    const react = discordMsg.react.bind(discordMsg);
    const removeOwnReaction = discordMsg.removeOwnReaction?.bind(discordMsg);
    return createStatusReactionController(
      { react, removeOwnReaction },
      this.statusReactionOptions,
    );
  }

  private async sendResponseParts(
    discordMsg: DiscordMessageLike,
    parts: Array<string | DiscordMessagePayload>,
  ): Promise<void> {
    let first = true;
    let pendingText = '';
    const send = async (part: DiscordSendPayload): Promise<void> => {
      if (first) {
        await discordMsg.reply(part);
        first = false;
      } else {
        await discordMsg.channel.send(part);
      }
    };
    const flushText = async (): Promise<void> => {
      if (!pendingText.trim()) {
        pendingText = '';
        return;
      }
      for (const chunk of splitMessage(pendingText, this.maxLen)) {
        await send(chunk);
      }
      pendingText = '';
    };

    for (const part of parts) {
      if (typeof part === 'string') {
        pendingText += part;
      } else {
        await flushText();
        await send(part);
      }
    }
    await flushText();
  }
}

export function renderDiscordArtifactMessages(artifact: OutboundArtifact): DiscordMessagePayload[] {
  if (artifact.kind === 'artifact-set') {
    const own = renderSingleArtifactMessage(artifact, false);
    const children = artifact.children?.flatMap(renderDiscordArtifactMessages) ?? [];
    return own ? [own, ...children] : children;
  }
  const message = renderSingleArtifactMessage(artifact, true);
  return message ? [message] : [];
}

function renderSingleArtifactMessage(
  artifact: OutboundArtifact,
  includeFiles: boolean,
): DiscordMessagePayload | null {
  const files = includeFiles
    ? (artifact.attachments ?? []).flatMap((attachment) => {
        const buffer = decodeAttachment(attachment.data);
        return buffer ? [{ attachment: buffer, name: safeFilename(attachment.name, attachment.mimeType) }] : [];
      })
    : [];
  const embeds = artifact.url && artifact.kind === 'image'
    ? [{
        title: artifact.title ? truncate(artifact.title, 256) : undefined,
        description: artifact.text ? truncate(artifact.text, 4096) : undefined,
        color: 0x2ecc71,
        image: { url: artifact.url },
      }]
    : [];
  const content = [artifact.title ? `**${truncate(artifact.title, 300)}**` : '', artifact.text ?? '']
    .filter(Boolean)
    .join('\n');
  if (!content && files.length === 0 && embeds.length === 0) return null;
  return {
    ...(content ? { content } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(embeds.length > 0 ? { embeds } : {}),
    allowedMentions: { parse: [] },
  };
}

function decodeAttachment(data: string): Buffer | null {
  const raw = data.trim();
  const match = /^data:[^;]+;base64,(.+)$/i.exec(raw);
  const b64 = (match?.[1] ?? raw).replace(/\s+/g, '');
  if (!b64) return null;
  const buffer = Buffer.from(b64, 'base64');
  return buffer.length > 0 ? buffer : null;
}

function safeFilename(name: string, mimeType: string): string {
  const fallback = `attachment.${extensionForMime(mimeType)}`;
  const cleaned = (name || fallback).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
  const finalName = cleaned.replace(/^-+|-+$/g, '') || fallback;
  return /\.[a-z0-9]+$/i.test(finalName) ? finalName : `${finalName}.${extensionForMime(mimeType)}`;
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/gif') return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  return 'bin';
}

function hasResponseContent(parts: Array<string | DiscordMessagePayload>): boolean {
  return parts.some((part) => {
    if (typeof part === 'string') return part.trim().length > 0;
    return Boolean(part.content?.trim() || part.files?.length || part.embeds?.length);
  });
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function mentionIncludesUser(message: DiscordMessageLike, userId: string): boolean {
  if (message.mentions.users.has(userId)) return true;
  for (const user of message.mentions.users.values()) {
    if (user.id === userId) return true;
  }
  return false;
}

function channelSetMatches(
  channels: ReadonlySet<string>,
  channelId: string,
  parentId?: string | null,
): boolean {
  return (
    channels.has('*') ||
    channels.has(channelId) ||
    (parentId !== null && parentId !== undefined && channels.has(parentId))
  );
}

function attachmentSignature(message: DiscordMessageLike): string {
  if (!message.attachments?.keys) return '';
  return [...message.attachments.keys()].sort().join(',');
}

function buildMessageFingerprint(message: DiscordMessageLike): string {
  return `${normalizeWhitespace(message.content)}|${attachmentSignature(message)}`;
}

function hasAttachments(message: DiscordMessageLike): boolean {
  return (message.attachments?.size ?? 0) > 0;
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
