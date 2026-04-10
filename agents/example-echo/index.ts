/**
 * example-echo — bootstrap entry point.
 *
 * Usage:
 *   const transport = new LocalTransport();
 *   const contextLoader = new CoreContextLoader({ root: 'context' });
 *   const llm = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY });
 *   await startExampleEcho({ transport, contextLoader, llm, tools: [...] });
 */

import { bootstrapAgent, AgentRunner, CoreToolExecutor } from '@nexora/core';
import { createReactArchitecture } from '@nexora/architectures';
import type {
  Transport,
  ContextLoader,
  ToolDefinition,
  LLMProvider,
  SecretAccessor,
  ToolLogger,
} from '@nexora/contracts';
import card from './agent.config.js';

export interface StartExampleEchoOptions {
  transport: Transport;
  contextLoader: ContextLoader;
  llm: LLMProvider;
  /** All tools the agent COULD use; per-tenant filtering is applied via context.tools */
  tools: ToolDefinition[];
  /** Tenant secret accessor — defaults to no-op */
  secrets?: SecretAccessor;
  /** Per-call logger — defaults to console */
  logger?: ToolLogger;
}

const NOOP_SECRETS: SecretAccessor = { get: async () => undefined };
const CONSOLE_LOGGER: ToolLogger = {
  info: (msg, data) => console.log(`[example-echo] ${msg}`, data ?? ''),
  warn: (msg, data) => console.warn(`[example-echo] ${msg}`, data ?? ''),
  error: (msg, data) => console.error(`[example-echo] ${msg}`, data ?? ''),
};

export async function startExampleEcho(options: StartExampleEchoOptions) {
  const secrets = options.secrets ?? NOOP_SECRETS;
  const logger = options.logger ?? CONSOLE_LOGGER;

  return bootstrapAgent({
    card,
    contextLoader: options.contextLoader,
    transport: options.transport,
    createRuntime: ({ context }) => {
      // Filter tools by the tenant's allowed list (if non-empty).
      const allowed = context.tools.length > 0 ? new Set(context.tools) : null;
      const tools = allowed
        ? options.tools.filter(t => allowed.has(t.name))
        : options.tools;

      return new AgentRunner({
        architecture: createReactArchitecture({
          systemPrompt: context.systemPrompt,
          model: context.limits.model,
          maxTokens: context.limits.maxTokens,
        }),
        llm: options.llm,
        tools: new CoreToolExecutor({
          tools,
          // ToolContext rebuilt per-request from the tenant's runtime context.
          context: {
            tenantId: context.tenantId,
            workdir: context.runtime.workdir,
            secrets,
            logger,
          },
        }),
        idleTimeoutMs: context.limits.maxExecutionMs,
      });
    },
    toAgentInput: (env) => {
      const payload = env.payload as { prompt?: string };
      return { prompt: payload.prompt ?? '' };
    },
  });
}
