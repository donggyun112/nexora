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
import { createReadTool, createGrepTool } from '@nexora/tools';
import { LocalTransport } from '@nexora/transport';
import { HttpAdapter } from '@nexora/adapters';
import { GatewayRouter } from '@nexora/gateway';
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

const llm = new SmartMockLLM();
const transport = new LocalTransport();

const simpleContextLoader: ContextLoader = {
  async load(_tenantId: string, _agentName: string): Promise<AgentContext> {
    return {
      tenantId: _tenantId ?? 'default',
      systemPrompt: 'You are a helpful AI agent.',
      tools: [],
      limits: {},
      runtime: { workdir: process.cwd() },
    } as unknown as AgentContext;
  },
};

// ─── 3. Bootstrap Agents ─────────────────────────────────────────────────

const tools = [createReadTool(), createGrepTool()];
const workdir = process.cwd();

for (const card of [coder, researcher, assistant]) {
  await bootstrapAgent({
    card,
    contextLoader: simpleContextLoader,
    transport,
    createRuntime: () => {
      return new AgentRunner({
        architecture: createReactArchitecture({
          systemPrompt: `You are ${card.name}, a specialized AI agent. ${card.description}.`,
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
    toAgentInput: (env) => ({
      prompt: typeof env.payload === 'object' && env.payload !== null
        ? (env.payload as { prompt?: string; content?: string }).prompt
          ?? (env.payload as { content?: string }).content
          ?? JSON.stringify(env.payload)
        : String(env.payload),
    }),
  });
}

// ─── 4. Gateway ──────────────────────────────────────────────────────────

const router = new GatewayRouter({
  transport,
  defaultTopic: topic('assistant.requested'),
  timeoutMs: 10_000,
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
