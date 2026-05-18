/**
 * createReporterMiddleware — taps the agent middleware pipeline and
 * publishes ReportEvents so outbound bridges (Discord, web SSE, …) can
 * render the agent's activity.
 *
 * Selection happens in two layers:
 *   1. ToolDefinition.visibility hints user intent (`public` / `detail` /
 *      `silent`). Default = 'silent' (fail-closed).
 *   2. An optional predicate from the caller can override the visibility
 *      check, e.g. "always emit for jira tools when input.preview is true".
 *
 * Errors and budget events are surfaced regardless of visibility, because
 * operators always need to see them.
 *
 * The producer is fire-and-forget — `transport.publish()` is awaited but
 * the middleware does not block tool execution on the result.
 */

import type {
  EventTransport,
  MessageEnvelope,
  ToolDefinition,
  TopicString,
} from '@nexora/contracts';
import { messageId, spanId } from '@nexora/contracts';
import {
  type ReportEvent,
  type ReportEnvelopePayload,
  type ReportSeverity,
  reportTopic,
} from './events.js';

/** Hook contexts (structurally compatible with @nexora/core middleware). */
interface ToolCtxLike {
  toolName: string;
  callId: string;
  input?: unknown;
  tool?: ToolDefinition;
}
interface ToolResultLike {
  toolName: string;
  callId: string;
  input?: unknown;
  result: { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | { type: 'error'; message: string };
  isError: boolean;
}
interface CompactCtxLike {
  beforeTokens: number;
  afterTokens: number;
  messagesBefore: number;
  messagesAfter: number;
}
interface BudgetCtxLike {
  policyId: string;
  spent: number;
  limit: number;
}

interface MiddlewareShape {
  name: string;
  beforeToolCall?(ctx: ToolCtxLike): void | Promise<void>;
  afterToolCall?(ctx: ToolResultLike): void | Promise<void>;
  onCompact?(ctx: CompactCtxLike): void | Promise<void>;
  onBudgetExceeded?(ctx: BudgetCtxLike): void | Promise<void>;
}

export type ReporterEventKind = ReportEvent['type'];

export interface ReporterContext {
  /** Resolved session key for routing (caller-provided). */
  sessionKey: string;
  /** Tenant id (caller-provided, passed through to envelope metadata). */
  tenantId: string;
  /** Discord channel id when the caller can supply it. */
  channelId?: string;
  /** Discord thread id when applicable. */
  threadId?: string;
}

export interface ReporterPredicateInput {
  event: ReportEvent;
  tool?: ToolDefinition;
}

export type ReporterPredicate = (input: ReporterPredicateInput) => boolean;

export interface ReporterMiddlewareOptions {
  transport: EventTransport;
  /**
   * Topic suffix — events are published to `report.<channel>`. Default: 'default'.
   */
  channel?: string;
  /**
   * Resolves run-time context (sessionKey, tenant, channel/thread) from a
   * tool call. Must be supplied by the caller — the middleware has no way
   * to know these from the hook context alone.
   */
  resolveContext: (ctx: { toolName: string; callId: string; input?: unknown }) =>
    | ReporterContext
    | null
    | undefined;
  /**
   * Filter what gets published. Default: visibility === 'public', plus all
   * errors and budget events. Return true to publish.
   */
  predicate?: ReporterPredicate;
  /**
   * Subset of event kinds to emit. Default: all kinds enabled.
   */
  events?: ReadonlyArray<ReporterEventKind>;
  /** Cap on input/result preview length (chars). Default 800. */
  maxPreviewChars?: number;
  /** Optional logger for diagnostic messages. */
  logger?: { warn?: (msg: string, data?: unknown) => void };
}

const DEFAULT_PREVIEW = 800;

export function createReporterMiddleware(
  options: ReporterMiddlewareOptions,
): MiddlewareShape {
  const {
    transport,
    channel = 'default',
    resolveContext,
    predicate = defaultPredicate,
    events,
    maxPreviewChars = DEFAULT_PREVIEW,
    logger,
  } = options;

  const topic = reportTopic(channel) as TopicString;
  const enabledKinds = events ? new Set(events) : null;
  // callId → { tool, startedAt }. Tool is captured at start so afterToolCall
  // can pass the same ToolDefinition into the predicate (visibility lookup).
  const callState = new Map<string, { tool?: ToolDefinition; startedAt: number }>();

  function emit(
    event: ReportEvent,
    tool: ToolDefinition | undefined,
    routing: ReporterContext,
  ): void {
    if (enabledKinds && !enabledKinds.has(event.type)) return;
    if (!predicate({ event, tool })) return;
    const payload: ReportEnvelopePayload = { event };
    const envelope: MessageEnvelope = {
      id: messageId(),
      topic: topic as string,
      type: 'event',
      payload,
      metadata: {
        traceId: routing.sessionKey,
        spanId: spanId(),
        conversationId: routing.sessionKey,
        tenantId: routing.tenantId,
        sourceInstanceId: 'reporter-middleware',
        timestamp: event.timestamp,
      },
    };
    void transport.publish(envelope).catch((err) => {
      logger?.warn?.('reporter.publish_failed', {
        kind: event.type,
        err: String(err),
      });
    });
  }

  return {
    name: 'reporter',
    beforeToolCall(ctx) {
      const routing = resolveContext({
        toolName: ctx.toolName,
        callId: ctx.callId,
        input: ctx.input,
      });
      if (!routing) return;
      callState.set(ctx.callId, { tool: ctx.tool, startedAt: Date.now() });
      const event: ReportEvent = {
        type: 'tool_start',
        toolName: ctx.toolName,
        callId: ctx.callId,
        sessionKey: routing.sessionKey,
        channelId: routing.channelId,
        threadId: routing.threadId,
        visibility: ctx.tool?.visibility,
        inputPreview: previewJson(ctx.input, maxPreviewChars),
        severity: 'info',
        timestamp: Date.now(),
      };
      emit(event, ctx.tool, routing);
    },
    afterToolCall(ctx) {
      const routing = resolveContext({
        toolName: ctx.toolName,
        callId: ctx.callId,
        input: ctx.input,
      });
      if (!routing) return;
      const prior = callState.get(ctx.callId);
      callState.delete(ctx.callId);
      const severity: ReportSeverity = ctx.isError ? 'error' : 'info';
      const preview =
        ctx.result.type === 'text'
          ? truncate(ctx.result.text, maxPreviewChars)
          : ctx.result.type === 'error'
            ? truncate(ctx.result.message, maxPreviewChars)
            : '[image]';
      const event: ReportEvent = {
        type: 'tool_end',
        toolName: ctx.toolName,
        callId: ctx.callId,
        sessionKey: routing.sessionKey,
        channelId: routing.channelId,
        threadId: routing.threadId,
        isError: ctx.isError,
        resultPreview: preview,
        durationMs: prior ? Date.now() - prior.startedAt : undefined,
        severity,
        timestamp: Date.now(),
      };
      emit(event, prior?.tool, routing);
    },
    onCompact(ctx) {
      const routing = resolveContext({ toolName: '__compact__', callId: '' });
      if (!routing) return;
      const event: ReportEvent = {
        type: 'compact',
        sessionKey: routing.sessionKey,
        channelId: routing.channelId,
        threadId: routing.threadId,
        beforeTokens: ctx.beforeTokens,
        afterTokens: ctx.afterTokens,
        messagesBefore: ctx.messagesBefore,
        messagesAfter: ctx.messagesAfter,
        severity: 'info',
        timestamp: Date.now(),
      };
      emit(event, undefined, routing);
    },
    onBudgetExceeded(ctx) {
      const routing = resolveContext({ toolName: '__budget__', callId: '' });
      if (!routing) return;
      const event: ReportEvent = {
        type: 'budget',
        sessionKey: routing.sessionKey,
        channelId: routing.channelId,
        threadId: routing.threadId,
        policyId: ctx.policyId,
        spent: ctx.spent,
        limit: ctx.limit,
        severity: 'warn',
        timestamp: Date.now(),
      };
      emit(event, undefined, routing);
    },
  };
}

/** Default policy: public tools get emitted, plus all errors and budget. */
function defaultPredicate(input: ReporterPredicateInput): boolean {
  const ev = input.event;
  if (ev.type === 'error' || ev.type === 'budget') return true;
  // Tool events use the tool's visibility hint; missing = silent.
  if (ev.type === 'tool_start' || ev.type === 'tool_end') {
    if (ev.type === 'tool_end' && ev.isError) return true;
    return input.tool?.visibility === 'public';
  }
  // thinking / compact — emit when severity is not info, otherwise skip.
  return ev.severity === 'warn' || ev.severity === 'error';
}

function previewJson(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return truncate(str, max);
  } catch {
    return undefined;
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}
