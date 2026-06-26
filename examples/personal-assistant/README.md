# Personal Assistant — OpenClaw-style 1:1 AI companion on Nexora

> **"Can I build OpenClaw with Nexora?"**
> Yes. Here's the core in 30 lines.

This example shows a single AI assistant connected to Discord, behaving
like an OpenClaw bot — but built on Nexora's multi-agent infrastructure.
The same assistant could serve multiple tenants, join a group conversation
with other agents, delegate work, raise hands to humans, track costs, and
resume after a crash. None of that is possible with a raw LLM SDK.

## The 30-line version

```typescript
import { ConversationRoom, TurnManager } from '@dongkseo/conversation';
import { DiscordAdapter } from '@dongkseo/adapters';
import { PiAiProvider } from '@dongkseo/core';
import { defineAgent, topic } from '@dongkseo/contracts';

const card = defineAgent({
  name: 'assistant',
  description: 'Personal AI assistant',
  architecture: 'conversation',
  tools: ['read', 'grep', 'web_search'],
  subscribes: [topic('assistant.requested')],
  publishes: [topic('assistant.completed')],
});

const llm = new PiAiProvider({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
const room = new ConversationRoom('discord-session');
room.join({ card, llm });

const tm = new TurnManager({ maxResponders: 1 });

const adapter = new DiscordAdapter({
  client: yourDiscordClient,
  resolveTenant: (guildId) => guildId ?? 'dm',
});

await adapter.start({
  async route(msg) {
    const rmsg = room.addUserMessage(msg.content, msg.displayName);
    const result = await tm.handleMessage(room, rmsg);
    return { content: result.responses[0]?.content ?? '(no response)' };
  },
  async routeStream(msg, onChunk) {
    const out = await this.route(msg);
    onChunk({ type: 'text', text: out.content });
    onChunk({ type: 'done', content: out.content });
  },
});
```

That's it. Your Discord bot is now a personal assistant.

## What you get for free (that OpenClaw doesn't have)

| Feature | How to enable |
|---|---|
| **Add more agents to the same channel** | `room.join(anotherAgent)` — TurnManager decides who speaks |
| **Agent delegates to specialist** | Add `createDelegateTool(transport, registry)` to tools |
| **Agent asks human when unsure** | Add `createHandraiseTool({ transport })` to tools |
| **Per-tenant persona/tools/limits** | Use `CoreContextLoader` + `bootstrapAgent` instead of direct room wiring |
| **Cost tracking** | Add `createBudgetMiddleware({ tracker, agentName, tenantId })` |
| **Crash recovery** | Use `ConversationRoom({ store })` for persistent history |
| **Full trace in Jaeger** | Wrap transport with `OTelTransport` |
| **Workflow chains** | Define a `WorkflowContract` and use `WorkflowEngine` |

## OpenClaw vs Nexora comparison

| | OpenClaw | Nexora |
|---|---|---|
| **What it is** | A product (personal AI companion) | A framework (build any AI agent system) |
| **Agents per channel** | 1 | N (with turn-taking protocol) |
| **Multi-tenant** | No | Yes (same binary, different context per tenant) |
| **Agent-to-agent** | No | Yes (delegate, conversation, workflow) |
| **HITL** | Limited | handraise + HandraisePolicy auto-answer |
| **Cost control** | No | BudgetTracker + middleware |
| **Crash recovery** | No | Workflow checkpoint + room persistence |
| **Observability** | Logs | OTel spans (Jaeger/Tempo/Honeycomb) |
| **Adapters** | 11 channel plugins | HTTP + Discord + Paperclip (+ your own) |
| **Hook system** | 11 hooks | 5 middleware hooks (extensible) |
| **UI** | React dashboard | None (CLI + HTTP API) |

## Run this example

```bash
export DISCORD_TOKEN=your-bot-token
export ANTHROPIC_API_KEY=sk-...
pnpm build
node examples/personal-assistant/dist/main.js
```

Then message your bot on Discord.
