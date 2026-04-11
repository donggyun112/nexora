# Getting Started with Nexora

This is the **one** path from zero to a running agent. No alternatives, no
forks, no "you could also try...". Follow these steps exactly.

## Prerequisites

- Node.js 22+
- pnpm 10+
- An Anthropic API key (set `ANTHROPIC_API_KEY` env var)

## Step 1: Create your agent

```bash
npx @nexora/cli create agent my-agent --tools read,grep --arch react
```

This creates `agents/my-agent/` with:
- `agent.config.ts` — what your agent can do (tools, topics, architecture)
- `index.ts` — bootstrap entry point
- `persona.md` — who your agent is

## Step 2: Set up context

Create a `context/` directory with your agent's identity:

```bash
mkdir -p context/personas
cp agents/my-agent/persona.md context/personas/my-agent.md
```

Edit `context/personas/my-agent.md` to describe your agent's role.

## Step 3: Write the entry point

Create `main.ts` in your project root:

```typescript
import { LocalTransport } from '@nexora/transport';
import { CoreContextLoader } from '@nexora/context';
import { AnthropicProvider } from '@nexora/core';
import { createReadTool, createGrepTool } from '@nexora/tools';
import { startMyAgent } from './agents/my-agent/index.js';

const transport = new LocalTransport();
const contextLoader = new CoreContextLoader({ root: './context' });
const llm = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY });

const running = await startMyAgent({
  transport,
  contextLoader,
  llm,
  tools: [createReadTool(), createGrepTool()],
});

console.log(`Agent ${running.card.name} is running.`);
console.log('Press Ctrl+C to stop.');

process.on('SIGINT', async () => {
  await running.shutdown();
  await transport.close();
  process.exit(0);
});
```

## Step 4: Send a message

In another terminal (or in the same script after bootstrap):

```typescript
import { createEnvelope } from '@nexora/transport';

await transport.publish(createEnvelope({
  topic: 'my-agent.requested',
  payload: { prompt: 'What files are in the current directory?' },
  metadata: { tenantId: 'default' },
}));
```

Your agent will:
1. Receive the message via its subscribed topic
2. Load context for the tenant (persona, limits, tools)
3. Run the ReAct loop (LLM → tool calls → LLM → done)
4. Publish the result to `my-agent.completed`

## Step 5: See the result

Subscribe to the result topic before publishing:

```typescript
transport.subscribe('my-agent.completed', async (env) => {
  const result = env.payload as { content: string };
  console.log('Agent response:', result.content);
});
```

## That's it.

One agent, one transport, one context loader, one LLM. Everything else
(multi-tenant, workflow, conversation, OTel) builds on this same pattern.

## Next steps

| Want to... | Read... |
|---|---|
| Add more agents | Create another with `nexora create agent` and join them on the same transport |
| Route HTTP requests to agents | See `@nexora/adapters` HttpAdapter + `@nexora/gateway` GatewayRouter |
| Chain agents into a workflow | See `@nexora/orchestrator` WorkflowEngine |
| Multi-tenant configuration | See `@nexora/context` TenantConfigStore |
| Agent conversation (who answers?) | See `@nexora/conversation` (experimental) |
| Trace in Jaeger | See `@nexora/otel` (experimental) |
