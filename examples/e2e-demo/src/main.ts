/**
 * Nexora E2E Demo — runnable without API keys.
 *
 * 3 agents, HTTP endpoint, full pipeline verification.
 *
 * Run:
 *   pnpm build && cd examples/e2e-demo && pnpm start
 *
 * Test:
 *   curl -X POST http://localhost:3000/messages \
 *     -H "Content-Type: application/json" \
 *     -d '{"content": "hello"}'
 *
 *   curl -X POST http://localhost:3000/messages \
 *     -H "Content-Type: application/json" \
 *     -d '{"content": "who are you"}'
 *
 *   curl -X POST http://localhost:3000/messages \
 *     -H "Content-Type: application/json" \
 *     -d '{"content": "what tools do you have?"}'
 */

import { defineAgent, topic } from '@nexora/contracts';
import { bootstrapAgent, AgentRunner, CoreToolExecutor } from '@nexora/core';
import { createReactArchitecture } from '@nexora/architectures';
import { createReadTool, createGrepTool, createDelegateTool } from '@nexora/tools';
import { LocalTransport } from '@nexora/transport';
import { HttpAdapter } from '@nexora/adapters';
import { GatewayRouter, LocalRuntimeRouter } from '@nexora/gateway';
import { InMemoryAgentRegistry } from '@nexora/registry';
import { SmartMockLLM } from './mock-llm.js';

import type { ContextLoader, AgentContext } from '@nexora/contracts';

// ─── 1. Agents ──────────────────────────────────────────────────────────

const coder = defineAgent({
  name: 'coder',
  version: '0.1.0',
  description: 'Reads and analyzes code files',
  architecture: 'react',
  tools: ['read', 'grep'],
  capabilities: ['code-reading', 'file-analysis'],
  subscribes: [topic('coder.requested')],
  publishes: [topic('coder.completed')],
});

const researcher = defineAgent({
  name: 'researcher',
  version: '0.1.0',
  description: 'Searches and researches information',
  architecture: 'react',
  tools: ['grep'],
  capabilities: ['search', 'research'],
  subscribes: [topic('researcher.requested')],
  publishes: [topic('researcher.completed')],
});

const assistant = defineAgent({
  name: 'assistant',
  version: '0.1.0',
  description: 'General-purpose assistant, routes to specialists',
  architecture: 'react',
  tools: ['read', 'grep'],
  capabilities: ['general', 'routing'],
  subscribes: [topic('assistant.requested')],
  publishes: [topic('assistant.completed')],
});

// ─── 2. Infrastructure ──────────────────────────────────────────────────

import { AnthropicProvider, FallbackLLMProvider, createProvider } from '@nexora/core';
import type { LLMProvider } from '@nexora/contracts';

function createLLM(): LLMProvider {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  const toolDefs = [...baseTools, createDelegateTool({ transport, registry, callerAgentName: 'assistant' })];
  const tools = toolDefs.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));

  // Priority: Anthropic direct → OpenRouter → Mock
  if (anthropicKey) {
    const anthropicTools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    console.log('[LLM] Using Anthropic (claude-haiku-4-5)');
    return new FallbackLLMProvider({
      providers: [
        { name: 'anthropic', provider: new AnthropicProvider({ apiKey: anthropicKey, defaultModel: 'claude-haiku-4-5-20251001', tools: anthropicTools }) },
        { name: 'mock', provider: new SmartMockLLM() },
      ],
      onFallback: (from, to, reason) => console.log(`[LLM] ${from} → ${to}: ${reason}`),
    });
  }
  if (openrouterKey) {
    console.log('[LLM] Using OpenRouter');
    return createProvider('openrouter', { apiKey: openrouterKey, tools });
  }
  console.log('[LLM] No API key — using mock LLM');
  return new SmartMockLLM();
}

const transport = new LocalTransport();
const registry = new InMemoryAgentRegistry();

// Register all agent cards so delegate can discover by capability
for (const card of [coder, researcher, assistant]) {
  await registry.register(card);
}

const agentPrompts: Record<string, string> = {
  coder: 'You are coder, a code-reading specialist. You analyze source files and explain code.',
  researcher: 'You are researcher, an information specialist. You search and synthesize findings.',
  assistant: 'You are assistant, a general-purpose agent. Delegate to coder or researcher when their expertise is needed.',
};

const simpleContextLoader: ContextLoader = {
  async load(_tenantId: string, _agentName: string): Promise<AgentContext> {
    return {
      tenantId: _tenantId ?? 'default',
      systemPrompt: agentPrompts[_agentName] ?? 'You are a helpful AI agent.',
      tools: [],
      limits: {},
      runtime: { workdir: process.cwd() },
    } as unknown as AgentContext;
  },
};

// ─── 3. Bootstrap Agents ─────────────────────────────────────────────────

const readTool = createReadTool();
readTool.isConcurrencySafe = true;
readTool.maxResultSizeChars = 50_000;

const grepTool = createGrepTool();
grepTool.isConcurrencySafe = true;

const baseTools = [readTool, grepTool];
const workdir = process.cwd();
const llm = createLLM();

const toAgentInput = (env: { payload: unknown }) => ({
  prompt: typeof env.payload === 'object' && env.payload !== null
    ? (env.payload as { prompt?: string; content?: string }).prompt
      ?? (env.payload as { content?: string }).content
      ?? JSON.stringify(env.payload)
    : String(env.payload),
});

for (const card of [coder, researcher, assistant]) {
  await bootstrapAgent({
    card,
    contextLoader: simpleContextLoader,
    transport,
    createRuntime: () => {
      const tools = card.name === 'assistant'
        ? [...baseTools, createDelegateTool({ transport, registry, callerAgentName: card.name })]
        : baseTools;

      return new AgentRunner({
        architecture: createReactArchitecture({
          systemPrompt: agentPrompts[card.name],
        }),
        llm,
        tools: new CoreToolExecutor({
          tools,
          context: {
            tenantId: 'default',
            workdir,
            secrets: { get: async () => undefined },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
          },
        }),
      });
    },
    toAgentInput,
  });
}

// ─── 4. Gateway — LocalRuntimeRouter for real streaming ──────────────────

const router = new LocalRuntimeRouter({
  createRuntime: (message) => {
    const tenantId = message.tenantId ?? 'default';
    const tools = [
      ...baseTools,
      createDelegateTool({ transport, registry, callerAgentName: 'assistant' }),
    ];
    return new AgentRunner({
      architecture: createReactArchitecture({
        systemPrompt: agentPrompts['assistant'],
      }),
      llm,
      tools: new CoreToolExecutor({
        tools,
        context: {
          tenantId,
          workdir,
          secrets: { get: async () => undefined },
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        },
      }),
    });
  },
});

const http = new HttpAdapter({
  port: Number(process.env.PORT ?? 3000),
  host: '0.0.0.0',
  resolveTenant: () => 'default',
});

await http.start(router);

console.log(`
╔════════════════════════════════════════════════════════╗
║  Nexora E2E Demo — 3 agents, no API key needed        ║
║                                                        ║
║  Agents: coder, researcher, assistant                  ║
║  HTTP:   http://localhost:${http.port()}                          ║
║                                                        ║
║  Try:                                                  ║
║  curl localhost:${http.port()}/messages -d '{"content":"hello"}'  ║
║  curl localhost:${http.port()}/messages -d '{"content":"help"}'   ║
║  curl localhost:${http.port()}/messages -d '{"content":"who are you"}'   ║
║  curl localhost:${http.port()}/health                             ║
║                                                        ║
║  Press Ctrl+C to stop.                                 ║
╚════════════════════════════════════════════════════════╝
`);

process.on('SIGINT', async () => {
  await http.stop();
  await transport.close();
  process.exit(0);
});

export { llm, transport, router, http };
