// ─── Adapters: 외부 채널 ↔ Nexora MessageRouter 경계 ───────────────────────
//
// 섹션 맵 (에이전트용: 무엇이 어느 파일에 있는지 — 정확한 타입은 해당 파일을 signatures 모드로)
//   HTTP            ./http              HttpAdapter (node:http, Express 없음)
//   Discord 채널    ./discord           DiscordAdapter, renderDiscordArtifactMessages
//   Discord 봇 부트  ./discord-bot       startDiscordBot, RunningDiscordBot
//   Discord 리액션  ./discord-reactions  createStatusReactionController, DEFAULT_EMOJI_MAP
//   Discord 승인    ./discord-approvals  bridgeDiscordApprovals (휴먼인더루프 승인 버튼)
//   Discord 리포트  ./discord-reports   bridgeDiscordReports (산출물/리포트 게시)
//   Slack 채널      ./slack             SlackAdapter
//   Paperclip       ./paperclip         PaperclipAdapter (외부 이슈 트래커 폴링)
//   Session key     ./session-key       buildSessionKey, isSharedSession
//   Anthropic 인증  ./anthropic-auth    resolveAnthropicApiKey (Claude OAuth 토큰 회전)
//   Codex 인증      ./codex-auth        resolveCodexApiKey (Codex JWT 회전)
//
// 모든 채널 어댑터는 `start(router)`/`stop()`로 MessageRouter에 붙는다.
// SDK 비의존: discord.js·@slack 등은 dependency가 아니며 호출자가 client를 주입한다.
// 새 모듈을 export하면 여기 한 줄 추가. API 설명은 각 파일 TSDoc이 정본 — 위는 위치 안내만.

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

export { resolveCodexApiKey } from './codex-auth.js';
export { resolveAnthropicApiKey } from './anthropic-auth.js';
