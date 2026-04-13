/**
 * DiscordAgentBot — framework-level Discord multi-agent bot.
 *
 * One function call: Discord bot with N agents, @mention routing,
 * !agents discovery, group chat fallback, per-guild tenants.
 *
 * This is the "it just works" layer on top of DiscordAdapter + GatewayRouter.
 *
 * ```typescript
 * const team = await createAgentTeam({ agents: [...], llm });
 * const bot = await startDiscordBot({ team, client });
 * // Done. @mention routes to specific agent, unmentioned → group chat.
 * ```
 */

import type {
  MessageRouter,
  InboundMessage,
  OutboundMessage,
  OutboundChunk,
  TopicString,
} from '@nexora/contracts';
import { DiscordAdapter, type DiscordClientLike } from './discord.js';

export interface DiscordAgentBotOptions {
  /** The agent team (from createAgentTeam). Provides cards, transport, registry. */
  team: {
    readonly cards: ReadonlyArray<{
      name: string;
      description: string;
      capabilities: readonly string[];
      subscribes: readonly string[];
    }>;
    readonly transport: {
      request(topic: string, payload: unknown, opts?: unknown): Promise<{ payload: unknown }>;
      subscribe?(topic: string, handler: (env: unknown) => void): unknown;
    };
    readonly llm: {
      complete(messages: unknown[], options?: unknown): Promise<{ content: string }>;
    };
    describeAll(): Array<{ name: string; description: string; capabilities: string[] }>;
  };
  /** Pre-authenticated discord.js Client instance. */
  client: DiscordClientLike;
  /**
   * Map of Discord bot user IDs → agent names.
   * If not provided, agents are routed by name match in message content.
   */
  agentBotIds?: Record<string, string>;
  /** Topic for group chat (when no agent is @mentioned). Default: 'group.requested' */
  groupTopic?: string;
  /** Tenant resolver. Default: guildId as tenantId. */
  resolveTenant?: (guildId: string | null) => string | null;
}

export interface RunningDiscordBot {
  adapter: DiscordAdapter;
  stop(): Promise<void>;
}

/**
 * Start a Discord bot with automatic multi-agent routing.
 *
 * Features provided automatically:
 * - @mention → routes to that agent's topic
 * - !agents → lists all agents with descriptions
 * - No mention → routes to group topic (for TurnManager)
 * - Per-guild tenant isolation
 * - Typing indicator while processing
 * - Message splitting for Discord's 2000 char limit
 */
export async function startDiscordBot(options: DiscordAgentBotOptions): Promise<RunningDiscordBot> {
  const { team, client } = options;
  const groupTopic = options.groupTopic ?? 'group.requested';

  // Build agent bot map from provided IDs
  const agentBotMap = new Map<string, string>();
  if (options.agentBotIds) {
    for (const [botId, agentName] of Object.entries(options.agentBotIds)) {
      agentBotMap.set(botId, agentName);
    }
  }

  // Build descriptions from team
  const agentDescriptions = new Map<string, string>();
  for (const info of team.describeAll()) {
    agentDescriptions.set(info.name, info.description);
  }

  // Wire group chat: subscribe to group topic and use round-robin
  // agent selection for unmentioned messages. Full TurnManager integration
  // requires @nexora/conversation — this provides a working fallback.
  if (team.transport.subscribe) {
    const agentTopics = team.cards.map(c => {
      const sub = c.subscribes[0];
      return typeof sub === 'string' ? sub : '';
    }).filter(Boolean);

    if (agentTopics.length > 0) {
      let roundRobinIdx = 0;
      team.transport.subscribe(groupTopic, async (env: unknown) => {
        // Route to agents round-robin when no specific agent is mentioned
        const targetTopic = agentTopics[roundRobinIdx % agentTopics.length];
        roundRobinIdx++;
        try {
          const typed = env as { payload: unknown; metadata?: { tenantId?: string; conversationId?: string } };
          await team.transport.request(targetTopic, typed.payload, {
            tenantId: typed.metadata?.tenantId,
            conversationId: typed.metadata?.conversationId,
            timeoutMs: 120_000,
          });
        } catch {
          // Best effort
        }
      });
    }
  }

  // Create a router that handles mention-based routing
  const router = createTeamRouter(team, groupTopic);

  const adapter = new DiscordAdapter({
    client,
    resolveTenant: options.resolveTenant ?? ((guildId) => guildId ?? 'default'),
    agentBotMap,
    agentDescriptions,
  });

  await adapter.start(router);

  return {
    adapter,
    stop: () => adapter.stop(),
  };
}

/**
 * Create a MessageRouter that routes based on mentionedAgent metadata.
 * Uses transport.request() for agent communication.
 */
function createTeamRouter(
  team: DiscordAgentBotOptions['team'],
  groupTopic: string,
): MessageRouter {
  // Build a set of known agent names for validation
  const knownAgents = new Set(team.cards.map(c => c.name));

  return {
    async route(message: InboundMessage): Promise<OutboundMessage> {
      const topic = resolveAgentTopic(message, knownAgents, groupTopic);

      const reply = await team.transport.request(topic, {
        prompt: message.content,
        content: message.content,
        requesterId: message.userId,
        requesterName: message.displayName,
        channelId: message.channelId,
      }, {
        tenantId: message.tenantId,
        conversationId: message.conversationId,
        timeoutMs: 120_000,
      });

      const payload = reply.payload as { content?: string; error?: string };
      return {
        content: payload.content ?? payload.error ?? '(no response)',
      };
    },

    async routeStream(
      message: InboundMessage,
      onChunk: (chunk: OutboundChunk) => void,
    ): Promise<void> {
      // For now, use non-streaming route and emit as single chunk
      const result = await this.route(message);
      onChunk({ type: 'text', text: result.content });
      onChunk({ type: 'done', content: result.content });
    },
  };
}

function resolveAgentTopic(
  message: InboundMessage,
  knownAgents: Set<string>,
  groupTopic: string,
): string {
  // Check for @mention routing
  const mentioned = (message.metadata as Record<string, unknown> | undefined)?.mentionedAgent;
  if (typeof mentioned === 'string' && knownAgents.has(mentioned)) {
    return `${mentioned}.requested`;
  }

  // Check for inline agent name (e.g., "@coder help me")
  for (const name of knownAgents) {
    if (message.content.toLowerCase().includes(`@${name}`)) {
      return `${name}.requested`;
    }
  }

  // Default: group chat topic
  return groupTopic;
}
