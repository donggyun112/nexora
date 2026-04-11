# Helpdesk — Nexora Reference App

A full-stack example that proves every layer of Nexora works together:

```
curl POST /messages
  → HttpAdapter
  → GatewayRouter (transport.request)
  → LocalTransport
  → bootstrapped helpdesk-agent
  → CoreContextLoader.load(tenantId)
  → AgentRunner (ReAct + read + grep tools)
  → result topic
  → HTTP response
```

## Run (with real LLM)

```bash
export ANTHROPIC_API_KEY=sk-...
pnpm build
node examples/helpdesk/dist/main.js
```

```bash
curl -X POST http://localhost:3000/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "What files are in packages/contracts/src?"}'
```

## Run (tests, no API key needed)

```bash
cd examples/helpdesk
pnpm test
```

## Multi-tenant

Pass `X-Tenant-Id` header to get per-tenant behavior:

```bash
# Default tenant — standard support
curl -X POST http://localhost:3000/messages \
  -H "X-Tenant-Id: default" \
  -d '{"content": "help me"}'

# Premium tenant — different persona, limits, tools
curl -X POST http://localhost:3000/messages \
  -H "X-Tenant-Id: premium" \
  -d '{"content": "help me"}'
```

## What this example demonstrates

| Nexora feature | Where it shows up |
|---|---|
| `defineAgent` | `main.ts:35` — agent card declaration |
| `CoreContextLoader` | `main.ts:45` — per-tenant persona loading |
| `bootstrapAgent` | `main.ts:52` — auto-subscribe + context wiring |
| `createRuntime({ context })` | `main.ts:56` — tenant-specific limits, model, tools |
| `AgentRunner` + ReAct | `main.ts:60` — LLM reasoning + tool calls |
| `createReadTool` / `createGrepTool` | `main.ts:68` — file I/O tools |
| `GatewayRouter` | `main.ts:79` — HTTP → topic → reply |
| `HttpAdapter` | `main.ts:85` — REST API entry point |
| `LocalTransport` | `main.ts:43` — agent communication bus |
| `resolveTenant` | `main.ts:88` — X-Tenant-Id header → tenantId |

## Before / After comparison

### Without Nexora (raw Express + Anthropic SDK)

```typescript
// ~150 lines of glue code per agent
const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/messages', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  // Manual tenant config loading...
  const tenantConfig = JSON.parse(fs.readFileSync(`config/${tenantId}.json`));
  // Manual system prompt assembly...
  const systemPrompt = fs.readFileSync(`personas/${tenantId}/agent.md`);
  // Manual tool definition...
  const tools = [{ name: 'read', ... }, { name: 'grep', ... }];
  // Manual ReAct loop...
  let messages = [{ role: 'user', content: req.body.content }];
  while (true) {
    const response = await anthropic.messages.create({ ... });
    if (response.stop_reason === 'tool_use') {
      // Manual tool execution...
      // Manual result formatting...
      // Manual history management...
    } else break;
  }
  // Manual tracing? Manual schema validation? Manual tenant isolation?
  // Manual abort on timeout? Manual compaction? No.
  res.json({ content: response.content });
});
```

### With Nexora

```typescript
// main.ts — 30 lines of wiring, framework handles the rest
const running = await bootstrapAgent({
  card: helpdeskCard,           // declarative capability
  contextLoader,                // per-tenant context
  transport,                    // communication bus
  createRuntime: ({ context }) => new AgentRunner({
    architecture: createReactArchitecture({
      systemPrompt: context.systemPrompt,  // tenant-specific
    }),
    llm,
    tools: new CoreToolExecutor({ tools, context: { ... } }),
    idleTimeoutMs: context.limits.maxExecutionMs,
  }),
  toAgentInput: (env) => ({ prompt: env.payload.prompt }),
});
```

Everything else — ReAct loop, tool execution, schema validation, tenant
isolation, abort signal, compaction, tracing, publish lint — is handled
by the framework.
