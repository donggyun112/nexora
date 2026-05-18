/**
 * bridgeDiscordApprovals — outbound HITL bridge from a HandraiseInbox to
 * Discord buttons.
 *
 * When an ApprovalRequest arrives in the inbox, this bridge renders a
 * 4-button embed (Allow Once / Allow Session / Always Allow / Deny) and
 * posts it to the originating Discord channel. The channel id is decoded
 * from the request's sessionKey — which was built by `buildSessionKey()`
 * on the inbound side, so the round-trip is symmetrical.
 *
 * Authorization: per-click. The interaction's user id / role ids are
 * checked against the request's allowedUsers / allowedRoles. Unauthorized
 * clicks get an ephemeral "not allowed" reply and the prompt stays open.
 *
 * SDK independence: we don't import discord.js. The caller passes a
 * minimal client that supports `interactionCreate` events and a
 * `resolveChannel(channelId)` resolver. discord.js consumers wrap their
 * `Client` once and pass it in.
 */

import type {
  ApprovalChoice,
  ApprovalRequest,
  ApprovalReply,
  HandraiseInbox,
  PendingHandraise,
} from '@nexora/tools';
import { isApprovalRequest } from '@nexora/tools';

const DEFAULT_CHOICES: ApprovalChoice[] = ['once', 'session', 'always', 'deny'];

const CHOICE_STYLE: Record<ApprovalChoice, number> = {
  // Discord button styles: 1=Primary(blurple) 2=Secondary(grey) 3=Success(green) 4=Danger(red)
  once: 3,
  session: 2,
  always: 1,
  deny: 4,
};

const CHOICE_LABEL: Record<ApprovalChoice, string> = {
  once: 'Allow Once',
  session: 'Allow Session',
  always: 'Always Allow',
  deny: 'Deny',
};

const CUSTOM_ID_PREFIX = 'nexora_approval';

// ─── SDK-light interfaces ─────────────────────────────────────────────────

export interface DiscordApprovalChannel {
  send(payload: {
    content?: string;
    embeds?: unknown[];
    components?: unknown[];
  }): Promise<DiscordApprovalMessage>;
}

export interface DiscordApprovalMessage {
  id: string;
  edit?: (payload: {
    content?: string;
    embeds?: unknown[];
    components?: unknown[];
  }) => Promise<unknown>;
}

export interface DiscordButtonInteraction {
  customId: string;
  user: { id: string; username: string };
  /** Guild member info; absent in DMs. */
  member?: { roleIds: ReadonlyArray<string> } | null;
  /**
   * Reply to the interaction (used for unauthorized notices). Setting
   * `ephemeral: true` makes the reply visible only to the clicker.
   */
  reply(payload: { content: string; ephemeral?: boolean }): Promise<unknown>;
  /** Replace the original message — used to disable buttons after a decision. */
  update(payload: {
    content?: string;
    embeds?: unknown[];
    components?: unknown[];
  }): Promise<unknown>;
}

export interface DiscordApprovalsClient {
  on(
    event: 'interactionCreate',
    handler: (interaction: DiscordButtonInteraction) => void,
  ): void;
  off(
    event: 'interactionCreate',
    handler: (interaction: DiscordButtonInteraction) => void,
  ): void;
}

export interface BridgeDiscordApprovalsOptions {
  client: DiscordApprovalsClient;
  inbox: HandraiseInbox;
  /** Resolve a Discord channel id to a sink that can `.send(...)`. */
  resolveChannel: (channelId: string) => Promise<DiscordApprovalChannel | null>;
  /**
   * Override the channel id chosen for an approval. Defaults to parsing
   * `request.sessionKey`. Return null to drop the request.
   */
  resolveChannelId?: (request: ApprovalRequest) => string | null;
  /** Custom embed/components renderer. */
  render?: (request: ApprovalRequest) => {
    embeds: unknown[];
    components: unknown[];
  };
  /** Logger for diagnostics. */
  logger?: { info?: (msg: string, data?: unknown) => void; warn?: (msg: string, data?: unknown) => void };
}

export interface ApprovalsBridge {
  /** Hand a pending request to the bridge (also wired via inbox.onPending). */
  handlePending(entry: PendingHandraise): Promise<void>;
  /** Detach interaction listeners and clear in-flight state. */
  stop(): void;
}

interface InFlight {
  entryId: string;
  request: ApprovalRequest;
  message: DiscordApprovalMessage;
  resolved: boolean;
}

export function bridgeDiscordApprovals(
  options: BridgeDiscordApprovalsOptions,
): ApprovalsBridge {
  const { client, inbox, resolveChannel } = options;
  const resolveChannelId =
    options.resolveChannelId ?? defaultResolveChannelId;
  const render = options.render ?? defaultRender;
  const logger = options.logger;

  const inFlight = new Map<string, InFlight>(); // keyed by entryId
  const customIdIndex = new Map<string, string>(); // customId → entryId

  const interactionHandler = async (interaction: DiscordButtonInteraction) => {
    if (!interaction.customId.startsWith(`${CUSTOM_ID_PREFIX}:`)) return;

    const [, entryId, choice] = interaction.customId.split(':');
    const target = entryId ? inFlight.get(entryId) : null;
    if (!target || target.resolved) {
      try {
        await interaction.reply({
          content: 'This approval has already been resolved.',
          ephemeral: true,
        });
      } catch {
        // ignore
      }
      return;
    }

    if (!isAuthorized(interaction, target.request)) {
      try {
        await interaction.reply({
          content: 'You are not authorized to decide on this approval.',
          ephemeral: true,
        });
      } catch {
        // ignore
      }
      return;
    }

    const choiceTyped = choice as ApprovalChoice;
    target.resolved = true;
    inFlight.delete(target.entryId);
    customIdIndex.forEach((eid, cid) => {
      if (eid === target.entryId) customIdIndex.delete(cid);
    });

    const reply: ApprovalReply = {
      choice: choiceTyped,
      userId: interaction.user.id,
      displayName: interaction.user.username,
    };

    try {
      await interaction.update({
        embeds: render(target.request).embeds,
        components: disabledComponents(target.request, choiceTyped, interaction.user.username),
      });
    } catch (err) {
      logger?.warn?.('approval.update_failed', { err: String(err) });
    }

    try {
      await inbox.answer(target.entryId, reply);
    } catch (err) {
      logger?.warn?.('approval.inbox_answer_failed', { err: String(err) });
    }
  };

  client.on('interactionCreate', interactionHandler);

  const bridge: ApprovalsBridge = {
    async handlePending(entry: PendingHandraise) {
      const request = entry.envelope.payload as
        | { context?: unknown }
        | undefined;
      const context = request?.context;
      if (!isApprovalRequest(context)) return; // not an approval — leave for other handlers

      const channelId = resolveChannelId(context);
      if (!channelId) {
        logger?.warn?.('approval.no_channel', { sessionKey: context.sessionKey });
        await inbox.reject(entry.id, 'no channel for approval');
        return;
      }

      const sink = await resolveChannel(channelId);
      if (!sink) {
        logger?.warn?.('approval.channel_unresolved', { channelId });
        await inbox.reject(entry.id, 'channel not resolvable');
        return;
      }

      const { embeds, components } = render(context);

      // Inject entryId into every button's customId so clicks can be routed.
      const tagged = tagComponents(components, entry.id);

      let message: DiscordApprovalMessage;
      try {
        message = await sink.send({ embeds, components: tagged });
      } catch (err) {
        logger?.warn?.('approval.send_failed', { err: String(err) });
        await inbox.reject(entry.id, 'failed to send approval prompt');
        return;
      }

      inFlight.set(entry.id, {
        entryId: entry.id,
        request: context,
        message,
        resolved: false,
      });
      collectCustomIds(tagged).forEach((cid) => customIdIndex.set(cid, entry.id));
    },

    stop() {
      client.off('interactionCreate', interactionHandler);
      inFlight.clear();
      customIdIndex.clear();
    },
  };

  // Auto-attach to the inbox's onPending so callers don't have to wire it.
  inbox.setOnPending((entry) => bridge.handlePending(entry));

  return bridge;
}

function isAuthorized(
  interaction: DiscordButtonInteraction,
  request: ApprovalRequest,
): boolean {
  const userOk =
    !request.allowedUsers || request.allowedUsers.includes(interaction.user.id);
  if (!userOk) return false;
  if (!request.allowedRoles || request.allowedRoles.length === 0) return true;
  const roleIds = interaction.member?.roleIds ?? [];
  return roleIds.some((id) => request.allowedRoles!.includes(id));
}

function defaultResolveChannelId(request: ApprovalRequest): string | null {
  // Explicit fields beat heuristics — when the middleware passes
  // channelId/threadId through resolveRoute, route exactly there.
  if (request.threadId) return request.threadId;
  if (request.channelId) return request.channelId;

  // Heuristic fallback: parse buildSessionKey output. This is best-effort
  // because the session key format is ambiguous between threadId and userId
  // at the same position (see buildSessionKey). Production callers should
  // configure resolveRoute on the middleware.
  //   agent:main:discord:dm:<chatId>[:<threadId>]
  //   agent:main:discord:<chatType>:<chatId>[:<threadId>][:<userId>]
  const parts = request.sessionKey.split(':');
  if (parts[2] !== 'discord' || parts.length < 5) return null;
  return parts[4]; // chatId — the safe choice when we can't disambiguate.
}

function defaultRender(request: ApprovalRequest): {
  embeds: unknown[];
  components: unknown[];
} {
  const choices = request.choices ?? DEFAULT_CHOICES;
  const embed = {
    title: 'Approval required',
    description: `\`\`\`\n${truncate(request.command, 1900)}\n\`\`\``,
    color: 0xf2a13c,
    fields: [
      { name: 'Reason', value: truncate(request.reason, 1024), inline: false },
    ],
  };
  const components = [
    {
      type: 1, // ActionRow
      components: choices.map((choice) => ({
        type: 2, // Button
        style: CHOICE_STYLE[choice],
        label: CHOICE_LABEL[choice],
        custom_id: `${CUSTOM_ID_PREFIX}::${choice}`, // entryId is filled in by tagComponents
      })),
    },
  ];
  return { embeds: [embed], components };
}

function tagComponents(components: unknown[], entryId: string): unknown[] {
  return components.map((row) => {
    const r = row as { type: number; components?: unknown[] };
    if (r.type !== 1 || !Array.isArray(r.components)) return row;
    return {
      ...r,
      components: r.components.map((btn) => {
        const b = btn as { type: number; custom_id?: string };
        if (b.type !== 2 || typeof b.custom_id !== 'string') return btn;
        const suffix = b.custom_id.startsWith(`${CUSTOM_ID_PREFIX}::`)
          ? b.custom_id.slice(`${CUSTOM_ID_PREFIX}::`.length)
          : b.custom_id;
        return { ...b, custom_id: `${CUSTOM_ID_PREFIX}:${entryId}:${suffix}` };
      }),
    };
  });
}

function collectCustomIds(components: unknown[]): string[] {
  const ids: string[] = [];
  for (const row of components) {
    const r = row as { components?: unknown[] };
    if (!Array.isArray(r.components)) continue;
    for (const btn of r.components) {
      const b = btn as { custom_id?: string };
      if (typeof b.custom_id === 'string') ids.push(b.custom_id);
    }
  }
  return ids;
}

function disabledComponents(
  request: ApprovalRequest,
  chosen: ApprovalChoice,
  decidedBy: string,
): unknown[] {
  const choices = request.choices ?? DEFAULT_CHOICES;
  return [
    {
      type: 1,
      components: choices.map((choice) => ({
        type: 2,
        style: CHOICE_STYLE[choice],
        label: choice === chosen ? `${CHOICE_LABEL[choice]} ✓ by ${decidedBy}` : CHOICE_LABEL[choice],
        custom_id: `${CUSTOM_ID_PREFIX}:resolved:${choice}`,
        disabled: true,
      })),
    },
  ];
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}
