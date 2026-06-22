/**
 * auto-work-flow — Multi-agent team: PM → Coder → Reviewer.
 *
 * Runnable without API keys (uses SmartMockLLM).
 *
 * Run:
 *   pnpm build && node dist/main.js
 *
 * Test:
 *   curl localhost:3000/messages -d '{"content": "hello"}'
 */

import { defineAgent, topic } from '@dongkseo/contracts';
import { bootstrapAgent, AgentRunner, CoreToolExecutor } from '@dongkseo/core';
import { createReactArchitecture } from '@dongkseo/architectures';
import {
  createReadTool, createGrepTool, createExecTool,
  createEditTool, createWriteTool, createDelegateTool,
  createKnowledgeTool, createHandraiseTool, HandraiseInbox,
} from '@dongkseo/tools';
import { LocalTransport } from '@dongkseo/transport';
import { InMemoryAgentRegistry } from '@dongkseo/registry';
import { InMemorySuspendedTurnStore } from '@dongkseo/orchestrator';
import { HttpAdapter } from '@dongkseo/adapters';
import { GatewayRouter } from '@dongkseo/gateway';

import type {
  LLMProvider, LLMMessage, LLMOptions, LLMChunk, LLMResponse,
  ContextLoader, AgentContext, ToolDefinition,
} from '@dongkseo/contracts';

// ─── 1. Agent definitions ───────────────────────────────────────────────

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

// ─── 2. Mock LLM (no API key needed) ───────────────────────────────────

class SmartMockLLM implements LLMProvider {
  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    const r = await this.complete(messages, options);
    yield { type: 'text_delta', delta: r.content };
    yield { type: 'done', content: r.content, stopReason: 'end_turn' };
  }
  async complete(messages: LLMMessage[], _options?: LLMOptions): Promise<LLMResponse> {
    const last = messages[messages.length - 1];
    const input = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    const lower = input.toLowerCase();
    if (lower.includes('hello') || lower.includes('안녕'))
      return reply('Hello! I\'m part of the auto-work-flow team. How can I help?');
    if (lower.includes('help') || lower.includes('도움'))
      return reply('I can plan work (PM), write code (Coder), and review it (Reviewer).');
    if (lower.includes('who are you'))
      return reply('I\'m an AI agent in a PM → Coder → Reviewer pipeline, powered by Nexora.');
    return reply(`Received: "${input.slice(0, 100)}". (Mock LLM — replace with a real provider for production.)`);
  }
}
function reply(content: string): LLMResponse {
  return { content, model: 'smart-mock', stopReason: 'end_turn' };
}

// ─── 3. Infrastructure ──────────────────────────────────────────────────

import { PiAiProvider, FallbackLLMProvider } from '@dongkseo/core';

function createLLM(): LLMProvider {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (anthropicKey) {
    console.log('[LLM] Using Anthropic (claude-haiku-4-5)');
    return new FallbackLLMProvider({
      providers: [
        { name: 'anthropic', provider: new PiAiProvider({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: anthropicKey }) },
        { name: 'mock', provider: new SmartMockLLM() },
      ],
      onFallback: (from, to, reason) => console.log(`[LLM] ${from} → ${to}: ${reason}`),
    });
  }
  if (openrouterKey) {
    console.log('[LLM] Using OpenRouter');
    return new PiAiProvider({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4', apiKey: openrouterKey });
  }
  console.log('[LLM] No API key — using mock LLM');
  return new SmartMockLLM();
}

const llm = createLLM();
const transport = new LocalTransport();
const registry = new InMemoryAgentRegistry();
const workdir = process.cwd();

const contextLoader: ContextLoader = {
  async load(_tenantId: string, _agentName: string): Promise<AgentContext> {
    return {
      tenantId: _tenantId ?? 'default',
      systemPrompt: 'You are a helpful AI agent.',
      tools: [],
      limits: {},
      runtime: { workdir },
    } as unknown as AgentContext;
  },
};

// ─── 4. Bootstrap agents ────────────────────────────────────────────────

const baseTools = [createReadTool(), createGrepTool()];

const toolsFor: Record<string, ToolDefinition[]> = {
  coder: [
    ...baseTools, createEditTool(), createExecTool(), createWriteTool(),
    createDelegateTool({ transport, registry, callerAgentName: 'coder' }),
  ],
  reviewer: [...baseTools, createKnowledgeTool({ get: async () => null, set: async () => {}, list: async () => [], delete: async () => {} } as any)],
  pm: [...baseTools, createKnowledgeTool({ get: async () => null, set: async () => {}, list: async () => [], delete: async () => {} } as any), createHandraiseTool({ transport, registry })],
};

// Suspend/resume for handraise(human): park a turn until the human answers,
// instead of blocking on a timeout. The HandraiseInbox renders pending
// questions; an operator answers via `handraiseInbox.answer(entryId, {answer})`,
// which publishes the reply that bootstrap resumes the parked turn from.
const suspendedTurnStore = new InMemorySuspendedTurnStore();
const handraiseInbox = new HandraiseInbox({
  transport,
  onPending: (entry) => {
    console.log(`[handraise pending] id=${entry.id} q=${JSON.stringify(entry.envelope.payload)}`);
  },
});
handraiseInbox.start();

for (const card of [coder, reviewer, pm]) {
  await registry.register(card);
  await bootstrapAgent({
    card,
    contextLoader,
    transport,
    suspendedTurnStore,
    createRuntime: ({ onSuspend }) =>
      new AgentRunner({
        architecture: createReactArchitecture({
          systemPrompt: `You are ${card.name}. ${card.description}`,
        }),
        llm,
        onSuspend,
        tools: new CoreToolExecutor({
          tools: toolsFor[card.name],
          context: {
            tenantId: 'default',
            workdir,
            secrets: { get: async () => undefined },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
          },
        }),
      }),
    toAgentInput: (env) => {
      const p = env.payload as any;
      const prompt = typeof env.payload === 'object' && env.payload !== null
        ? p.prompt ?? p.content ?? JSON.stringify(env.payload)
        : String(env.payload);
      return {
        prompt,
        images: Array.isArray(p?.images)
          ? p.images.map((i: { data: string; mimeType: string }) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))
          : undefined,
        files: Array.isArray(p?.files)
          ? p.files.map((f: { name?: string; data: string; mimeType: string; size?: number }) => ({ type: 'file' as const, ...f }))
          : undefined,
        history: p?.history,
      };
    },
  });
}

// ─── 5. Gateway (PM is the entry point) ─────────────────────────────────

const router = new GatewayRouter({
  transport,
  defaultTopic: topic('pm.requested'),
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
║  auto-work-flow — PM / Coder / Reviewer team           ║
║                                                        ║
║  HTTP: http://localhost:${http.port()}                          ║
║  Entry: PM agent (pm.requested)                        ║
║                                                        ║
║  curl localhost:${http.port()}/messages -d '{"content":"hello"}'  ║
║                                                        ║
║  Press Ctrl+C to stop.                                 ║
╚════════════════════════════════════════════════════════╝
`);

process.on('SIGINT', async () => {
  await http.stop();
  await transport.close();
  process.exit(0);
});

export { coder, reviewer, pm, http, transport };
