/**
 * bridgeDiscordReports — consumer bridge from `report.<channel>` events to
 * Discord embeds.
 *
 * Subscribes to the report topic on the shared EventTransport and renders
 * an embed per event. With `liveEdit: true` (default), tool_start emits a
 * message and the matching tool_end edits the same message so the embed
 * transitions from "running" to "done"/"error" in place — the same UX
 * auto-work-flow's message-renderer provides, but reusable.
 *
 * SDK independence: callers provide `resolveChannel(channelId)` + an
 * optional `client` is not needed at all (this side is read-only — no
 * interactions, no message events). Discord.js consumers wire it once and
 * pass it in.
 */

import {
  isReportEnvelopePayload,
  reportTopic,
  type ReportEvent,
  type ToolStartReport,
  type ToolEndReport,
  type ThinkingReport,
  type CompactReport,
  type BudgetReport,
  type ErrorReport,
} from '@dongkseo/tools';
import type {
  EventTransport,
  Subscription,
  TopicString,
  MessageEnvelope,
} from '@dongkseo/contracts';

// ─── SDK-light interfaces ─────────────────────────────────────────────────

export interface DiscordReportChannel {
  send(payload: {
    content?: string;
    embeds?: unknown[];
  }): Promise<DiscordReportMessage>;
}

export interface DiscordReportMessage {
  id: string;
  edit?: (payload: { content?: string; embeds?: unknown[] }) => Promise<unknown>;
}

export type ReportRenderer<E extends ReportEvent = ReportEvent> = (
  event: E,
) => { content?: string; embeds: unknown[] };

export interface DiscordReportRenderers {
  tool_start?: ReportRenderer<ToolStartReport>;
  tool_end?: ReportRenderer<ToolEndReport>;
  thinking?: ReportRenderer<ThinkingReport>;
  compact?: ReportRenderer<CompactReport>;
  budget?: ReportRenderer<BudgetReport>;
  error?: ReportRenderer<ErrorReport>;
}

export interface BridgeDiscordReportsOptions {
  transport: EventTransport;
  /** Resolve a channel id → sink. Same shape as the approvals bridge. */
  resolveChannel: (channelId: string) => Promise<DiscordReportChannel | null>;
  /**
   * Topic channel suffix. Subscribes to `report.<channel>`. Default: 'default'.
   */
  channel?: string;
  /**
   * Override channel id selection for a given event. Defaults to:
   *   threadId → channelId → null (drop).
   */
  resolveChannelId?: (event: ReportEvent) => string | null;
  /**
   * When true, tool_start emits a new message and tool_end edits it. The
   * cache key is (sessionKey, callId). Default: true.
   */
  liveEdit?: boolean;
  /** Custom renderers per event type. */
  renderers?: DiscordReportRenderers;
  /** Diagnostic logger. */
  logger?: { warn?: (msg: string, data?: unknown) => void };
}

export interface ReportsBridge {
  stop(): void;
}

export function bridgeDiscordReports(
  options: BridgeDiscordReportsOptions,
): ReportsBridge {
  const {
    transport,
    resolveChannel,
    channel = 'default',
    resolveChannelId = defaultResolveChannelId,
    liveEdit = true,
    renderers,
    logger,
  } = options;

  const topic = reportTopic(channel) as TopicString;
  // (sessionKey + callId) → message handle, for live-edit pairing
  const inFlight = new Map<string, DiscordReportMessage>();

  const subscription: Subscription = transport.subscribe(
    topic as string,
    async (envelope: MessageEnvelope) => {
      const payload = envelope.payload;
      if (!isReportEnvelopePayload(payload)) return;
      const event = payload.event;

      const channelId = resolveChannelId(event);
      if (!channelId) {
        logger?.warn?.('report.no_channel', { type: event.type });
        return;
      }

      const sink = await resolveChannel(channelId);
      if (!sink) {
        logger?.warn?.('report.channel_unresolved', { channelId });
        return;
      }

      const rendered = render(event, renderers);
      if (!rendered) return;

      const pairingKey =
        liveEdit && event.callId
          ? `${event.sessionKey}::${event.callId}`
          : null;

      if (event.type === 'tool_end' && pairingKey) {
        const existing = inFlight.get(pairingKey);
        if (existing?.edit) {
          try {
            await existing.edit(rendered);
            inFlight.delete(pairingKey);
            return;
          } catch (err) {
            logger?.warn?.('report.edit_failed', { err: String(err) });
            // Fall through to send a new message.
          }
        }
      }

      try {
        const msg = await sink.send(rendered);
        if (pairingKey && event.type === 'tool_start') {
          inFlight.set(pairingKey, msg);
        }
      } catch (err) {
        logger?.warn?.('report.send_failed', { err: String(err) });
      }
    },
  );

  return {
    stop() {
      subscription.unsubscribe();
      inFlight.clear();
    },
  };
}

function render(
  event: ReportEvent,
  custom: DiscordReportRenderers | undefined,
): { content?: string; embeds: unknown[] } | null {
  switch (event.type) {
    case 'tool_start':
      return (custom?.tool_start ?? defaultToolStart)(event);
    case 'tool_end':
      return (custom?.tool_end ?? defaultToolEnd)(event);
    case 'thinking':
      return (custom?.thinking ?? defaultThinking)(event);
    case 'compact':
      return (custom?.compact ?? defaultCompact)(event);
    case 'budget':
      return (custom?.budget ?? defaultBudget)(event);
    case 'error':
      return (custom?.error ?? defaultError)(event);
    default:
      return null;
  }
}

function defaultResolveChannelId(event: ReportEvent): string | null {
  return event.threadId ?? event.channelId ?? null;
}

// ─── Default renderers ────────────────────────────────────────────────────

const COLOR_INFO = 0x6c8ebf;
const COLOR_WARN = 0xf2a13c;
const COLOR_ERROR = 0xe06666;
const COLOR_DONE = 0x6aa84f;

function defaultToolStart(ev: ToolStartReport) {
  return {
    embeds: [
      {
        title: `🛠️ ${ev.toolName}`,
        description: ev.inputPreview
          ? '```\n' + truncate(ev.inputPreview, 1800) + '\n```'
          : '_running…_',
        color: COLOR_INFO,
        footer: { text: 'in progress' },
      },
    ],
  };
}

function defaultToolEnd(ev: ToolEndReport) {
  const icon = ev.isError ? '❌' : '✅';
  const color = ev.isError ? COLOR_ERROR : COLOR_DONE;
  const footer = ev.durationMs ? `${ev.durationMs} ms` : 'done';
  return {
    embeds: [
      {
        title: `${icon} ${ev.toolName}`,
        description: ev.resultPreview
          ? '```\n' + truncate(ev.resultPreview, 1800) + '\n```'
          : undefined,
        color,
        footer: { text: footer },
      },
    ],
  };
}

function defaultThinking(ev: ThinkingReport) {
  return {
    embeds: [
      {
        title: '🧠 thinking',
        description: truncate(ev.summary, 1900),
        color: COLOR_INFO,
      },
    ],
  };
}

function defaultCompact(ev: CompactReport) {
  return {
    embeds: [
      {
        title: '🗜️ context compacted',
        description: `${ev.messagesBefore} msgs / ${ev.beforeTokens} tok → ${ev.messagesAfter} msgs / ${ev.afterTokens} tok`,
        color: COLOR_INFO,
      },
    ],
  };
}

function defaultBudget(ev: BudgetReport) {
  return {
    embeds: [
      {
        title: '⚠️ budget exceeded',
        description: `policy \`${ev.policyId}\` — spent ${ev.spent} / limit ${ev.limit}`,
        color: COLOR_WARN,
      },
    ],
  };
}

function defaultError(ev: ErrorReport) {
  return {
    embeds: [
      {
        title: `❌ ${ev.toolName ?? 'error'}`,
        description: truncate(ev.message, 1900),
        color: COLOR_ERROR,
      },
    ],
  };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}
