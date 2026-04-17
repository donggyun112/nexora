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
import type { CompiledSubagent, Subagent } from '@nexora/tools';
import { LocalTransport } from '@nexora/transport';
import { HttpAdapter } from '@nexora/adapters';
import { GatewayRouter } from '@nexora/gateway';
import { InMemoryAgentRegistry } from '@nexora/registry';
import { SmartMockLLM } from './mock-llm.js';

import type { ContextLoader, AgentContext, MessageRouter, InboundMessage, OutboundMessage, OutboundChunk, AgentEvent } from '@nexora/contracts';

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
  const anthropicAuth = process.env.ANTHROPIC_AUTH_TOKEN;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  const toolDefs = [...baseTools, createDelegateTool({ transport, registry, callerAgentName: 'assistant' })];
  const tools = toolDefs.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));

  // Priority: Anthropic direct → OpenRouter → Mock
  if (anthropicKey || anthropicAuth) {
    const anthropicTools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    console.log('[LLM] Using Anthropic (claude-haiku-4-5)', anthropicAuth ? '(OAuth)' : '(API key)');
    return new FallbackLLMProvider({
      providers: [
        { name: 'anthropic', provider: new AnthropicProvider({ apiKey: anthropicKey, authToken: anthropicAuth, defaultModel: 'claude-haiku-4-5-20251001', tools: anthropicTools }) },
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
  coder: `You are coder, a code-reading specialist. You analyze source files and explain code. Always respond in the same language as the user.
You can delegate to "researcher" if you need information gathering. Use the delegate tool when needed.`,
  researcher: `You are researcher, an information specialist. You search and synthesize findings. Always respond in the same language as the user.
You can delegate to "coder" if you need code analysis. Use the delegate tool when needed.`,
  assistant: `You are assistant, a team lead coordinating coder and researcher agents.

IMPORTANT RULES:
- When the user asks about code, files, or technical analysis → delegate to "coder" using the delegate tool
- When the user asks for research or information gathering → delegate to "researcher" using the delegate tool
- When the user asks to talk to another agent → delegate to that agent
- You MUST use the delegate tool for specialized tasks. Do NOT try to do everything yourself.
- After receiving delegation results, summarize them for the user.
- Always respond in the same language as the user.

Available agents to delegate to:
- "coder" (capabilities: code-reading, file-analysis) — for code review, file reading, technical analysis
- "researcher" (capabilities: search, research) — for searching and researching information`,
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

function buildRuntime(name: string, extraTools: import('@nexora/contracts').ToolDefinition[] = []) {
  return new AgentRunner({
    architecture: createReactArchitecture({ systemPrompt: agentPrompts[name] }),
    llm,
    tools: new CoreToolExecutor({
      tools: [...baseTools, ...extraTools],
      context: { tenantId: 'default', workdir, secrets: { get: async () => undefined }, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    }),
  });
}

// Compiled subagents — can delegate to each other
const coderDelegate = createDelegateTool({
  transport, registry, callerAgentName: 'coder',
  subagents: [], // will be patched below
  blockedToolsForChild: [], // allow inter-agent communication
});
const researcherDelegate = createDelegateTool({
  transport, registry, callerAgentName: 'researcher',
  subagents: [],
  blockedToolsForChild: [],
});

const coderSubagent: CompiledSubagent = {
  type: 'compiled', name: 'coder',
  description: 'Code reading and file analysis specialist',
  runtime: buildRuntime('coder', [coderDelegate]),
};
const researcherSubagent: CompiledSubagent = {
  type: 'compiled', name: 'researcher',
  description: 'Search and research specialist',
  runtime: buildRuntime('researcher', [researcherDelegate]),
};

// Custom router: streams parent + child agent events to SSE with agent identity
function createAssistantRuntime(onChunk?: (c: OutboundChunk) => void) {
  const delegateTool = createDelegateTool({
    transport, registry, callerAgentName: 'assistant',
    subagents: [coderSubagent, researcherSubagent],
    onSubagentEvent: onChunk ? (name, event) => {
      if (event.type === 'text') onChunk({ type: 'text', text: event.text, agent: name });
      else if (event.type === 'tool_call') onChunk({ type: 'tool_call', name: event.name, input: event.input as Record<string,unknown>, agent: name });
      else if (event.type === 'tool_result') onChunk({ type: 'tool_result', name: event.name, isError: event.isError, agent: name });
    } : undefined,
  });
  return new AgentRunner({
    architecture: createReactArchitecture({ systemPrompt: agentPrompts['assistant'] }),
    llm,
    tools: new CoreToolExecutor({
      tools: [...baseTools, delegateTool],
      context: { tenantId: 'default', workdir, secrets: { get: async () => undefined }, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    }),
  });
}

const router: MessageRouter = {
  async route(msg: InboundMessage): Promise<OutboundMessage> {
    let content = '';
    for await (const ev of createAssistantRuntime().execute({ prompt: msg.content })) {
      if (ev.type === 'done') content = ev.content;
    }
    return { content };
  },
  async routeStream(msg: InboundMessage, onChunk: (c: OutboundChunk) => void): Promise<void> {
    for await (const ev of createAssistantRuntime(onChunk).execute({ prompt: msg.content })) {
      if (ev.type === 'text') onChunk({ type: 'text', text: ev.text, agent: 'assistant' });
      else if (ev.type === 'tool_call') {
        if (ev.name === 'delegate') onChunk({ type: 'delegate_start', from: 'assistant', to: String((ev.input as {capability?:string})?.capability ?? ''), capability: String((ev.input as {capability?:string})?.capability ?? '') });
        else onChunk({ type: 'tool_call', name: ev.name, input: ev.input as Record<string,unknown>, agent: 'assistant' });
      }
      else if (ev.type === 'tool_result' && ev.name === 'delegate') onChunk({ type: 'delegate_end', from: 'assistant', to: '' });
      else if (ev.type === 'tool_result') onChunk({ type: 'tool_result', name: ev.name, isError: ev.isError, agent: 'assistant' });
      else if (ev.type === 'done') onChunk({ type: 'done', content: ev.content, agent: 'assistant' });
      else if (ev.type === 'error') onChunk({ type: 'error', message: ev.message, agent: 'assistant' });
    }
  },
};

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
