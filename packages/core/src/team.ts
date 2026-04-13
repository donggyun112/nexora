/**
 * AgentTeam — framework-level multi-agent orchestration.
 *
 * Eliminates manual wiring. One call bootstraps N agents with:
 * - Transport (auto-created if not provided)
 * - Context loader (auto-created from directory)
 * - Per-agent runtime factory
 * - Agent registry (for delegation/discovery)
 * - Group chat support (ConversationRoom + TurnManager via topic)
 * - Automatic tool setup per agent card
 *
 * This is the "golden path" — the framework does the common case for you.
 */

import type {
  AgentCard,
  LLMProvider,
  EventTransport,
  ContextLoader,
  AgentRegistry,
  AgentLogger,
} from '@nexora/contracts';
import { bootstrapAgent, type RunningAgent } from './bootstrap.js';
import { AgentRunner } from './runner.js';

export interface AgentTeamOptions {
  /** Agent cards to bootstrap. Each gets its own runtime. */
  agents: AgentCard[];
  /** LLM provider (shared across all agents, or use per-agent override via context). */
  llm: LLMProvider;
  /** Transport for inter-agent communication. Auto-created (LocalTransport) if not set. */
  transport?: EventTransport;
  /** Context loader. Auto-created from contextDir if not set. */
  contextLoader?: ContextLoader;
  /** Context directory (used to auto-create CoreContextLoader). Default: './context' */
  contextDir?: string;
  /** Agent registry (auto-created InMemoryAgentRegistry if not set). */
  registry?: AgentRegistry;
  /** Per-agent runtime factory override. If not set, uses default ReAct + card.tools. */
  createRuntime?: (card: AgentCard) => AgentRunner | Promise<AgentRunner>;
  /** Logger */
  logger?: AgentLogger;
}

export interface AgentTeam {
  /** All agent cards in this team */
  readonly cards: readonly AgentCard[];
  /** The transport used for inter-agent communication */
  readonly transport: EventTransport;
  /** The registry containing all agents */
  readonly registry: AgentRegistry;
  /** The context loader */
  readonly contextLoader: ContextLoader;
  /** The LLM provider */
  readonly llm: LLMProvider;
  /** All running agent instances */
  readonly running: readonly RunningAgent[];
  /** Agent name → card lookup */
  getCard(name: string): AgentCard | undefined;
  /** Agent name → description for discovery */
  describeAll(): Array<{ name: string; description: string; capabilities: string[] }>;
  /** Graceful shutdown of all agents */
  shutdown(): Promise<void>;
}

/**
 * Create and bootstrap a team of agents.
 *
 * This is the main entry point for multi-agent systems.
 * It handles all wiring automatically:
 *
 * ```typescript
 * const team = await createAgentTeam({
 *   agents: [coderCard, reviewerCard, pmCard],
 *   llm: new AnthropicProvider({ apiKey: '...' }),
 *   contextDir: './context',
 * });
 *
 * // team.transport — for gateway routing
 * // team.registry — for delegation lookup
 * // team.describeAll() — for discovery commands
 * // team.shutdown() — graceful stop
 * ```
 */
export async function createAgentTeam(options: AgentTeamOptions): Promise<AgentTeam> {
  const logger = options.logger ?? NOOP_LOGGER;

  // Auto-create transport if not provided
  const transport = options.transport ?? await autoCreateTransport();

  // Auto-create registry if not provided
  const registry = options.registry ?? await autoCreateRegistry();

  // Auto-create context loader if not provided
  const contextLoader = options.contextLoader ?? await autoCreateContextLoader(
    options.contextDir ?? './context',
  );

  // Bootstrap all agents
  const running: RunningAgent[] = [];
  const cardsByName = new Map<string, AgentCard>();

  for (const card of options.agents) {
    cardsByName.set(card.name, card);

    const agent = await bootstrapAgent({
      card,
      contextLoader,
      transport,
      registry,
      logger,
      createRuntime: async ({ context, envelope }) => {
        if (options.createRuntime) {
          return options.createRuntime(card);
        }
        return autoCreateRuntime(card, options.llm, context);
      },
      toAgentInput: (envelope) => ({
        prompt: typeof envelope.payload === 'object' && envelope.payload !== null
          ? (envelope.payload as { prompt?: string; content?: string }).prompt
            ?? (envelope.payload as { content?: string }).content
            ?? JSON.stringify(envelope.payload)
          : String(envelope.payload),
      }),
    });
    running.push(agent);
  }

  logger.info(`AgentTeam created with ${options.agents.length} agents`, {
    agents: options.agents.map(a => a.name),
  });

  return {
    cards: options.agents,
    transport,
    registry,
    contextLoader,
    llm: options.llm,
    running,
    getCard: (name) => cardsByName.get(name),
    describeAll: () => options.agents.map(a => ({
      name: a.name,
      description: a.description,
      capabilities: [...a.capabilities],
    })),
    shutdown: async () => {
      for (const agent of running) {
        await agent.shutdown();
      }
      logger.info('AgentTeam shutdown');
    },
  };
}

// ─── Auto-creation helpers (dynamic import to avoid hard deps) ──────────

async function autoCreateTransport(): Promise<EventTransport> {
  const mod = await import('@nexora/transport' as string) as {
    LocalTransport: new () => EventTransport;
  };
  return new mod.LocalTransport();
}

async function autoCreateRegistry(): Promise<AgentRegistry> {
  const mod = await import('@nexora/registry' as string) as {
    InMemoryAgentRegistry: new () => AgentRegistry;
  };
  return new mod.InMemoryAgentRegistry();
}

async function autoCreateContextLoader(contextDir: string): Promise<ContextLoader> {
  const mod = await import('@nexora/context' as string) as {
    CoreContextLoader: new (opts: { root: string }) => ContextLoader;
  };
  return new mod.CoreContextLoader({ root: contextDir });
}

async function autoCreateRuntime(
  card: AgentCard,
  llm: LLMProvider,
  context: { systemPrompt?: string; limits?: { model?: string } },
): Promise<AgentRunner> {
  const archMod = await import('@nexora/architectures' as string) as {
    createReactArchitecture: (opts: { systemPrompt?: string; model?: string }) => import('@nexora/contracts').AgentArchitecture;
  };
  const toolsMod = await import('@nexora/tools' as string) as {
    createReadTool: () => import('@nexora/contracts').ToolDefinition;
    createGrepTool: () => import('@nexora/contracts').ToolDefinition;
    createExecTool: (opts: { allowList: string[] }) => import('@nexora/contracts').ToolDefinition;
    createWriteTool: () => import('@nexora/contracts').ToolDefinition;
    createEditTool: () => import('@nexora/contracts').ToolDefinition;
    createKnowledgeTool: (store: unknown) => import('@nexora/contracts').ToolDefinition;
  };

  const architecture = archMod.createReactArchitecture({
    systemPrompt: context.systemPrompt,
    model: context.limits?.model,
  });

  // Build tool list based on card.tools declaration
  const toolMap: Record<string, () => import('@nexora/contracts').ToolDefinition> = {
    read: () => toolsMod.createReadTool(),
    grep: () => toolsMod.createGrepTool(),
    exec: () => toolsMod.createExecTool({ allowList: ['git', 'npm', 'pnpm', 'node'] }),
    write: () => toolsMod.createWriteTool(),
    edit: () => toolsMod.createEditTool(),
  };

  const resolvedTools: import('@nexora/contracts').ToolDefinition[] = [];
  for (const toolName of card.tools) {
    const factory = toolMap[toolName];
    if (factory) resolvedTools.push(factory());
  }

  // Fallback: if card declares no tools or none matched, give read + grep
  if (resolvedTools.length === 0) {
    resolvedTools.push(toolsMod.createReadTool(), toolsMod.createGrepTool());
  }

  const { CoreToolExecutor: Executor } = await import('./tool-executor.js');
  const tools = new Executor({
    tools: resolvedTools,
    context: {
      tenantId: 'default',
      workdir: process.cwd(),
      secrets: { get: async () => undefined },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      signal: new AbortController().signal,
    },
  });

  return new AgentRunner({ architecture, llm, tools });
}

const NOOP_LOGGER: AgentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};
