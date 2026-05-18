/**
 * ReportEvent — typed envelope for surfacing agent activity to user-facing
 * UIs (Discord embeds, web panels, etc.).
 *
 * Produced by `createReporterMiddleware`, consumed by adapter bridges
 * (e.g. `bridgeDiscordReports`). The transport is the same EventTransport
 * used by handraise — events flow on `report.<channel>` topics. Bridges
 * subscribe and render per-event embeds.
 *
 * Wire convention: the producer publishes an envelope whose `payload` is
 * `{ event: ReportEvent }`. We don't reuse HandraiseRequestPayload here —
 * reports are fire-and-forget, no reply needed, no callId required.
 */

/** Severity / category. Determines default rendering (color, icon). */
export type ReportSeverity = 'info' | 'warn' | 'error';

interface ReportBase {
  /** Stable identifier for the originating agent run. */
  sessionKey: string;
  /** Optional tool callId (used by bridges to live-edit start → end). */
  callId?: string;
  /** Severity hint. Default: 'info'. */
  severity?: ReportSeverity;
  /** Wall-clock timestamp in ms. */
  timestamp: number;
  /** Discord channel id when known — bridges fall back to sessionKey. */
  channelId?: string;
  /** Discord thread id when applicable. */
  threadId?: string;
}

export interface ToolStartReport extends ReportBase {
  type: 'tool_start';
  toolName: string;
  /** Visibility hint copied from ToolDefinition (helps consumers filter). */
  visibility?: 'public' | 'detail' | 'silent';
  /** Truncated preview of the input (rendered as a code block). */
  inputPreview?: string;
}

export interface ToolEndReport extends ReportBase {
  type: 'tool_end';
  toolName: string;
  isError: boolean;
  /** Truncated result preview. */
  resultPreview?: string;
  /** Duration in ms when the producer measured it. */
  durationMs?: number;
}

export interface ThinkingReport extends ReportBase {
  type: 'thinking';
  /** Short summary of what the agent is reasoning about. */
  summary: string;
}

export interface CompactReport extends ReportBase {
  type: 'compact';
  beforeTokens: number;
  afterTokens: number;
  messagesBefore: number;
  messagesAfter: number;
}

export interface BudgetReport extends ReportBase {
  type: 'budget';
  policyId: string;
  spent: number;
  limit: number;
}

export interface ErrorReport extends ReportBase {
  type: 'error';
  message: string;
  /** Tool name when the error originated inside a tool. */
  toolName?: string;
}

export type ReportEvent =
  | ToolStartReport
  | ToolEndReport
  | ThinkingReport
  | CompactReport
  | BudgetReport
  | ErrorReport;

export interface ReportEnvelopePayload {
  event: ReportEvent;
}

/** Type guard for bridges that subscribe to mixed topics. */
export function isReportEnvelopePayload(
  value: unknown,
): value is ReportEnvelopePayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ReportEnvelopePayload).event === 'object' &&
    typeof ((value as ReportEnvelopePayload).event as { type?: unknown }).type ===
      'string'
  );
}

export function reportTopic(channel: string): string {
  return `report.${channel}`;
}
