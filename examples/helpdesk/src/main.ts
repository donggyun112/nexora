/**
 * Helpdesk reference app — the golden path in one file.
 *
 * This example proves the full Nexora stack works end-to-end:
 *
 *   HTTP POST /messages
 *     → HttpAdapter
 *     → GatewayRouter (transport.request)
 *     → LocalTransport publishes 'helpdesk.requested'
 *     → bootstrapped helpdesk-agent receives
 *     → CoreContextLoader.load(tenantId) — per-tenant persona + limits
 *     → AgentRunner.execute (ReAct architecture, read + grep tools)
 *     → publishes 'helpdesk.completed' with replyTo
 *     → GatewayRouter resolves
 *     → HttpAdapter sends JSON response
 *
 * Multi-tenant: pass X-Tenant-Id header to get different agent behavior.
 *
 * Run:
 *   pnpm build && node dist/main.js
 *   curl -X POST http://localhost:3000/messages \
 *     -H "Content-Type: application/json" \
 *     -H "X-Tenant-Id: default" \
 *     -d '{"content": "What files are in packages/contracts/src?"}'
 */

import { LocalTransport } from '@nexora/transport';
import { CoreContextLoader } from '@nexora/context';
import {
  AgentRunner,
  CoreToolExecutor,
  bootstrapAgent,
  AnthropicProvider,
} from '@nexora/core';
import { createReactArchitecture } from '@nexora/architectures';
import { createReadTool, createGrepTool } from '@nexora/tools';
import { HttpAdapter } from '@nexora/adapters';
import { GatewayRouter } from '@nexora/gateway';
import { defineAgent, topic } from '@nexora/contracts';
import type { TopicString } from '@nexora/contracts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const contextRoot = path.resolve(__dirname, '..', 'context');

// ── 1. Define the agent ────────────────────────────────────────────────────

const helpdeskCard = defineAgent({
  name: 'helpdesk-agent',
  version: '0.1.0',
  description: 'Developer support agent — reads code and answers questions',
  architecture: 'react',
  tools: ['read', 'grep'],
  capabilities: ['developer-support'],
  subscribes: [topic('helpdesk.requested')],
  publishes: [topic('helpdesk.completed')],
});

// ── 2. Wire infrastructure ─────────────────────────────────────────────────

const transport = new LocalTransport();
const contextLoader = new CoreContextLoader({
  root: contextRoot,
  defaultTools: ['read', 'grep'],
  workdirBase: process.cwd(),
});

const llm = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultModel: 'claude-sonnet-4-5',
});

// ── 3. Bootstrap the agent ─────────────────────────────────────────────────

// Create tools once — reused across all requests (stateless, read-only)
const readTool = createReadTool();
readTool.isConcurrencySafe = true;
readTool.maxResultSizeChars = 50_000;

const grepTool = createGrepTool();
grepTool.isConcurrencySafe = true;

const tools = [readTool, grepTool];

const running = await bootstrapAgent({
  card: helpdeskCard,
  contextLoader,
  transport,
  createRuntime: ({ context }) => {
    const allowed = context.tools.length > 0 ? new Set(context.tools) : null;
    const filtered = allowed ? tools.filter(t => allowed.has(t.name)) : tools;

    return new AgentRunner({
      architecture: createReactArchitecture({
        systemPrompt: context.systemPrompt,
        model: context.limits.model,
        maxTokens: context.limits.maxTokens,
      }),
      llm,
      tools: new CoreToolExecutor({
        tools: filtered,
        context: {
          tenantId: context.tenantId,
          workdir: context.runtime.workdir,
          // TODO: wire real secrets provider (e.g. AWS SSM, Vault) for production
          secrets: { get: async () => undefined },
          logger: console,
        },
      }),
      idleTimeoutMs: context.limits.maxExecutionMs,
    });
  },
  toAgentInput: (env) => ({
    prompt: (env.payload as { prompt?: string }).prompt ?? '',
  }),
});

// ── 4. Gateway: HTTP → Transport → Agent → Reply ───────────────────────────

const gatewayRouter = new GatewayRouter({
  transport,
  defaultTopic: topic('helpdesk.requested') as TopicString,
  timeoutMs: 120_000,
});

const adapter = new HttpAdapter({
  port: Number(process.env.PORT ?? 3000),
  host: '0.0.0.0',
  resolveTenant: (req) => req.headers['x-tenant-id'] as string ?? 'default',
});

await adapter.start(gatewayRouter);

console.log(`
╔═══════════════════════════════════════════════════╗
║  Nexora Helpdesk Agent — running on port ${adapter.port()}      ║
║                                                   ║
║  curl -X POST http://localhost:${adapter.port()}/messages \\     ║
║    -H "Content-Type: application/json" \\           ║
║    -d '{"content": "What is Nexora?"}'             ║
║                                                   ║
║  Health: http://localhost:${adapter.port()}/health              ║
╚═══════════════════════════════════════════════════╝
`);

// ── 5. Graceful shutdown ─��─────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await adapter.stop();
  await running.shutdown();
  await transport.close();
  process.exit(0);
});
