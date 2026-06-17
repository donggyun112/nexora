/**
 * @dongkseo/adapters — entry-point adapters.
 *
 * - HttpAdapter: REST API (node:http, no Express)
 * - DiscordAdapter: Discord bot (SDK-independent, pass your own discord.js Client)
 */

export { HttpAdapter } from './http.js';
export type { HttpAdapterOptions } from './http.js';

export { DiscordAdapter, renderDiscordArtifactMessages } from './discord.js';
export type {
  DiscordAdapterOptions,
  DiscordBotMessagePolicy,
  DiscordClientLike,
  DiscordMessageLike,
  DiscordMessagePayload,
  DiscordSendPayload,
} from './discord.js';

export {
  createStatusReactionController,
  DEFAULT_EMOJI_MAP,
} from './discord-reactions.js';
export type {
  ReactableMessage,
  StatusReactionController,
  StatusReactionOptions,
} from './discord-reactions.js';

export { buildSessionKey, isSharedSession } from './session-key.js';
export type {
  ChatType,
  SessionSource,
  SessionKeyOptions,
} from './session-key.js';

export { bridgeDiscordApprovals } from './discord-approvals.js';
export type {
  ApprovalsBridge,
  BridgeDiscordApprovalsOptions,
  DiscordApprovalChannel,
  DiscordApprovalMessage,
  DiscordApprovalsClient,
  DiscordButtonInteraction,
} from './discord-approvals.js';

export { bridgeDiscordReports } from './discord-reports.js';
export type {
  ReportsBridge,
  BridgeDiscordReportsOptions,
  DiscordReportChannel,
  DiscordReportMessage,
  DiscordReportRenderers,
  ReportRenderer,
} from './discord-reports.js';

export { startDiscordBot } from './discord-bot.js';
export type { DiscordAgentBotOptions, RunningDiscordBot } from './discord-bot.js';

export { PaperclipAdapter } from './paperclip.js';
export type {
  PaperclipAdapterOptions,
  PaperclipClientConfig,
  PaperclipIssue,
} from './paperclip.js';

export { SlackAdapter } from './slack.js';
export type {
  SlackAdapterOptions,
  SlackClientLike,
  SlackMessageEvent,
} from './slack.js';
