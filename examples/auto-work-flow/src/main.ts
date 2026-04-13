/**
 * auto-work-flow — Discord 멀티 에이전트 팀, Nexora로 재구현.
 *
 * 원본: 5개 전문 에이전트 (Orca, Mikasa, Dex, Ray, Mina)가
 *       Discord 서버에서 협업하는 시스템.
 *
 * 이 예제는 Nexora의 모든 핵심 기능을 사용합니다:
 * - DiscordAdapter (@mention 라우팅 + !agents 디스커버리)
 * - GatewayRouter (mention-based IntentResolver)
 * - bootstrapAgent × 3 (코더, 리뷰어, PM)
 * - ConversationRoom + TurnManager (그룹 대화)
 * - delegate tool (에이전트 간 위임)
 * - handraise tool (사람에게 질문)
 * - FallbackLLMProvider (Claude → GPT 폴백)
 * - CoreContextLoader (서버별 persona/tools)
 * - BudgetTracker (비용 제한)
 */

import { defineAgent, topic } from '@nexora/contracts';
import type { TopicString } from '@nexora/contracts';

// ─── 1. Agent Cards ─────────────────────────────────────────────────────

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
  description: 'Project manager. Plans work, tracks progress, approves changes.',
  architecture: 'react',
  tools: ['read', 'knowledge', 'handraise'],
  capabilities: ['project-management', 'planning', 'approval'],
  subscribes: [topic('pm.requested')],
  publishes: [topic('pm.completed')],
});

// ─── 2. Wiring (pseudo-code — actual setup needs discord.js + API keys) ─

/**
 * Full setup would look like this:
 *
 * ```typescript
 * import { Client, GatewayIntentBits } from 'discord.js';
 * import { DiscordAdapter } from '@nexora/adapters';
 * import { GatewayRouter, createMentionResolver } from '@nexora/gateway';
 * import { LocalTransport } from '@nexora/transport';
 * import { bootstrapAgent } from '@nexora/core';
 * import { CoreContextLoader } from '@nexora/context';
 * import { AnthropicProvider, FallbackLLMProvider, AgentRunner } from '@nexora/core';
 * import { createReactArchitecture } from '@nexora/architectures';
 * import { ConversationRoom, TurnManager } from '@nexora/conversation';
 *
 * // Transport
 * const transport = new LocalTransport();
 *
 * // LLM (Claude primary, GPT fallback)
 * const llm = new FallbackLLMProvider({
 *   providers: [
 *     { name: 'claude', provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }) },
 *     { name: 'gpt', provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }) },
 *   ],
 * });
 *
 * // Context (per-guild personas)
 * const contextLoader = new CoreContextLoader({ root: './context' });
 *
 * // Bootstrap 3 agents
 * for (const card of [coder, reviewer, pm]) {
 *   await bootstrapAgent({
 *     card,
 *     contextLoader,
 *     transport,
 *     createRuntime: ({ context }) => new AgentRunner({
 *       architecture: createReactArchitecture({
 *         systemPrompt: context.systemPrompt,
 *         model: context.limits.model,
 *       }),
 *       llm,
 *       tools: createToolExecutor(card.tools),
 *     }),
 *     toAgentInput: (env) => ({ prompt: (env.payload as { content: string }).content }),
 *   });
 * }
 *
 * // Discord adapter with @mention routing
 * const agentBotMap = new Map([
 *   ['BOT_USER_ID_CODER', 'coder'],
 *   ['BOT_USER_ID_REVIEWER', 'reviewer'],
 *   ['BOT_USER_ID_PM', 'pm'],
 * ]);
 *
 * const agentDescriptions = new Map([
 *   ['coder', 'Writes and executes code'],
 *   ['reviewer', 'Reviews code for quality and security'],
 *   ['pm', 'Plans work, tracks progress, approves changes'],
 * ]);
 *
 * const client = new Client({
 *   intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
 * });
 *
 * const adapter = new DiscordAdapter({
 *   client,
 *   resolveTenant: (guildId) => guildId ?? 'default',
 *   agentBotMap,
 *   agentDescriptions,
 * });
 *
 * const router = new GatewayRouter({
 *   transport,
 *   defaultTopic: topic('group.requested') as TopicString,
 *   intentResolver: createMentionResolver(),
 * });
 *
 * await client.login(process.env.DISCORD_TOKEN);
 * await adapter.start(router);
 *
 * // Group chat: if no @mention, TurnManager picks the best agent
 * const room = new ConversationRoom('group-session');
 * room.join({ card: coder, llm, respondPrompt: 'You are a coding specialist.' });
 * room.join({ card: reviewer, llm, respondPrompt: 'You review code quality.' });
 * room.join({ card: pm, llm, respondPrompt: 'You manage projects.' });
 *
 * const tm = new TurnManager({ maxResponders: 1 });
 * // When group.requested arrives, use TurnManager:
 * // const result = await tm.handleMessage(room, userMessage);
 * ```
 */

// ─── 3. What this proves ────────────────────────────────────────────────

/**
 * auto-work-flow 기능 매핑:
 *
 * | auto-work-flow            | Nexora                                     |
 * |---------------------------|---------------------------------------------|
 * | Discord bot I/O           | DiscordAdapter (SDK-independent)            |
 * | 5 specialized agents      | bootstrapAgent × N (topic-based routing)    |
 * | @agent mention routing    | agentBotMap + createMentionResolver()       |
 * | !agents command           | agentDescriptions in DiscordAdapter         |
 * | Agent delegation          | delegate tool (capability-based)            |
 * | Human approval            | handraise tool                              |
 * | Provider fallback         | FallbackLLMProvider + error classification  |
 * | Per-server config         | CoreContextLoader (guildId → tenant)        |
 * | Context compression       | TwoStageCompactor                           |
 * | Cost tracking             | BudgetTracker (4 scopes)                    |
 * | Workflow chains           | WorkflowEngine (checkpoint/resume)          |
 * | Group chat (who answers?) | ConversationRoom + TurnManager              |
 * | Audit trail               | AuditStore (PostgreSQL)                     |
 * | Tracing                   | OTel → Jaeger                               |
 */

export { coder, reviewer, pm };
