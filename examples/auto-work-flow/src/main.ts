/**
 * auto-work-flow — Discord 멀티 에이전트 팀.
 *
 * Nexora 프레임워크 레벨 API로 구현.
 * 100줄 와이어링이 아니라 10줄.
 */

import { defineAgent, topic } from '@nexora/contracts';

// ─── 1. 에이전트 정의 ──────────────────────────────────────────────────

const coder = defineAgent({
  name: 'coder',
  version: '0.1.0',
  description: 'Writes and executes code. Main workhorse.',
  architecture: 'react',
  tools: ['read', 'grep', 'edit', 'exec', 'write', 'delegate'],
  capabilities: ['code-execution', 'file-editing', 'debugging'],
  subscribes: [topic('coder.requested')],
  publishes: [topic('coder.completed')],
});

const reviewer = defineAgent({
  name: 'reviewer',
  version: '0.1.0',
  description: 'Reviews code for quality, security, and correctness.',
  architecture: 'react',
  tools: ['read', 'grep', 'knowledge'],
  capabilities: ['code-review', 'security-review'],
  subscribes: [topic('reviewer.requested')],
  publishes: [topic('reviewer.completed')],
});

const pm = defineAgent({
  name: 'pm',
  version: '0.1.0',
  description: 'Project manager. Plans work, tracks progress, approves.',
  architecture: 'react',
  tools: ['read', 'knowledge', 'handraise'],
  capabilities: ['project-management', 'planning', 'approval'],
  subscribes: [topic('pm.requested')],
  publishes: [topic('pm.completed')],
});

// ─── 2. 프레임워크가 전부 해줌 ──────────────────────────────────────────

/**
 * 실제 실행 코드 (discord.js + API 키 필요):
 *
 * ```typescript
 * import { createAgentTeam, AnthropicProvider } from '@nexora/core';
 * import { startDiscordBot } from '@nexora/adapters';
 * import { Client, GatewayIntentBits } from 'discord.js';
 *
 * // 1. 팀 생성 — transport, registry, context, runtime 전부 자동
 * const team = await createAgentTeam({
 *   agents: [coder, reviewer, pm],
 *   llm: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
 *   contextDir: './context',
 * });
 *
 * // 2. Discord 봇 시작 — 라우팅, 디스커버리, 멘션 전부 자동
 * const client = new Client({
 *   intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
 *             GatewayIntentBits.MessageContent],
 * });
 * await client.login(process.env.DISCORD_TOKEN);
 *
 * await startDiscordBot({ team, client });
 *
 * // 끝. 이제:
 * // - @coder "이 함수 고쳐줘" → coder 에이전트가 응답
 * // - @reviewer "이 PR 봐줘" → reviewer 에이전트가 응답
 * // - "이거 어떻게 해?" → TurnManager가 가장 적합한 에이전트 선택
 * // - !agents → 사용 가능한 에이전트 목록 표시
 * // - coder가 모르면 → reviewer에게 delegate
 * // - pm이 확인 필요하면 → handraise로 사람에게 질문
 * ```
 *
 * 프레임워크가 자동으로 처리하는 것:
 * - LocalTransport 생성 + 에이전트 구독
 * - InMemoryAgentRegistry 등록
 * - CoreContextLoader (./context 디렉토리)
 * - ReAct 아키텍처 + 도구 셋업
 * - @mention → 에이전트 topic 라우팅
 * - !agents → 에이전트 목록 + 설명
 * - 멘션 없는 메시지 → group.requested (그룹 대화)
 * - 2000자 메시지 분할
 * - 타이핑 인디케이터
 * - guildId → tenantId 매핑
 */

export { coder, reviewer, pm };
