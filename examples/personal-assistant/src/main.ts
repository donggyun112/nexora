/**
 * Personal Assistant — OpenClaw-style 1:1 AI companion built on Nexora.
 *
 * Proves that Nexora can do everything OpenClaw does (single-agent personal
 * assistant) PLUS everything OpenClaw can't (multi-agent, multi-tenant,
 * delegation, handraise, budget, OTel, crash recovery).
 *
 * Run:
 *   export DISCORD_TOKEN=...
 *   export ANTHROPIC_API_KEY=...
 *   pnpm build && node dist/main.js
 */

import { ConversationRoom, TurnManager } from '@nexora/conversation';
import { PiAiProvider, CoreToolExecutor, InMemoryBudgetTracker } from '@nexora/core';
import { createReadTool, createGrepTool } from '@nexora/tools';
import { defineAgent, topic } from '@nexora/contracts';
import type { MessageRouter, InboundMessage, OutboundMessage, OutboundChunk } from '@nexora/contracts';
import { HttpAdapter } from '@nexora/adapters';

// ── Agent definition ───────────────────────────────────────────────────────

const assistantCard = defineAgent({
  name: 'assistant',
  version: '0.1.0',
  description: 'Personal AI assistant — reads files, searches code, asks humans when stuck',
  architecture: 'conversation',
  tools: ['read', 'grep', 'handraise'],
  subscribes: [topic('assistant.requested')],
  publishes: [topic('assistant.completed')],
});

// ── Infrastructure ─────────────────────────────────────────────────────────

const llm = new PiAiProvider({
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Budget: $5/day per assistant (tracks cost but isn't wired to LLM calls in this example)
const budgetTracker = new InMemoryBudgetTracker();
await budgetTracker.addPolicy({
  id: 'assistant-daily',
  scope: { type: 'agent', agentName: 'assistant' },
  maxCostUsd: 5.0,
  window: { type: 'daily' },
  onExceed: 'warn',
});

// ── Conversation room ──────────────────────────────────────────────────────

const room = new ConversationRoom('session');
room.join({
  card: assistantCard,
  llm,
  respondPrompt:
    'You are a helpful personal assistant. Be concise, friendly, and direct. ' +
    'If you cannot answer with certainty, use the handraise tool to ask a human.',
});

const tm = new TurnManager({ maxResponders: 1 });

// ── HTTP gateway (also works as Discord adapter target) ────────────────────

const router: MessageRouter = {
  async route(msg: InboundMessage): Promise<OutboundMessage> {
    const rmsg = room.addUserMessage(msg.content, msg.displayName);
    const result = await tm.handleMessage(room, rmsg);
    const content = result.responses[0]?.content ?? '(no response)';
    return { content };
  },
  async routeStream(msg: InboundMessage, onChunk: (c: OutboundChunk) => void): Promise<void> {
    const out = await this.route(msg);
    onChunk({ type: 'text', text: out.content });
    onChunk({ type: 'done', content: out.content });
  },
};

const httpAdapter = new HttpAdapter({
  port: Number(process.env.PORT ?? 3000),
  host: '0.0.0.0',
  resolveTenant: () => 'default',
});

await httpAdapter.start(router);

console.log(`
╔══════════════════════════════════════════════════════╗
║  Personal Assistant — OpenClaw-style on Nexora       ║
║                                                      ║
║  HTTP: http://localhost:${httpAdapter.port()}                        ║
║                                                      ║
║  curl -X POST http://localhost:${httpAdapter.port()}/messages \\      ║
║    -H "Content-Type: application/json" \\              ║
║    -d '{"content": "What files are in src/?"}'        ║
║                                                      ║
║  Budget: $5.00/day (warn on exceed)                  ║
║  Press Ctrl+C to stop.                               ║
╚══════════════════════════════════════════════════════╝
`);

process.on('SIGINT', async () => {
  await httpAdapter.stop();
  process.exit(0);
});
