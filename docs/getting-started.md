# Getting Started with Nexora

**The one path. No alternatives.**

## Prerequisites

- Node.js 22+
- pnpm 10+
- `ANTHROPIC_API_KEY` environment variable

## Step 1: Create + run

```bash
mkdir my-project && cd my-project
pnpm init
pnpm add @dongkseo/contracts @dongkseo/core @dongkseo/architectures @dongkseo/cli
pnpm add -D typescript @types/node

# Scaffold an agent
pnpm exec nexora create agent my-agent --tools read,grep

# Build + start
pnpm exec tsc --init --target ES2022 --module ESNext --moduleResolution Bundler
pnpm exec tsc
pnpm exec nexora dev
```

## Step 2: Talk to it

```bash
curl -X POST http://localhost:3000/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "What files are in the current directory?"}'
```

Done. Your agent is running.

## What just happened

```
curl → HttpAdapter → LocalTransport → your agent → ReAct loop
  → read tool (lists files) → LLM response → HTTP reply
```

Four direct packages did everything:
- `@dongkseo/contracts` — types
- `@dongkseo/core` — runtime
- `@dongkseo/architectures` — ReAct runtime architecture used by the scaffold
- `@dongkseo/cli` — scaffold + dev server

## Step 3: Add capabilities (when you need them)

| I want to... | Do this |
|---|---|
| **Serve multiple customers** | `pnpm add @dongkseo/context` → create `context/tenants/{id}/tenant.json` |
| **Chain agents into a workflow** | `pnpm add @dongkseo/orchestrator` → define a `WorkflowContract` |
| **Connect to Discord** | `pnpm add @dongkseo/adapters` → use `DiscordAdapter` |
| **Track costs** | Use `InMemoryBudgetTracker` + `createBudgetMiddleware` (already in `@dongkseo/core`) |
| **Multiple agents in one channel** | `pnpm add @dongkseo/conversation` → `TurnManager` |
| **Agent asks a human** | `handraise` tool (already in `@dongkseo/tools` via `@dongkseo/cli`) |
| **Agent delegates to another** | `delegate` tool (same) |
| **Trace in Jaeger** | `pnpm add @dongkseo/otel` → wrap transport with `OTelTransport` |

**Don't add packages preemptively.** Start with the 3-package core. Add one at a time.

## Reference

- [examples/helpdesk/](../examples/helpdesk/) — full-stack E2E reference app
- [examples/personal-assistant/](../examples/personal-assistant/) — OpenClaw-style 1:1 bot
- [docs/architecture/public-api.md](architecture/public-api.md) — which packages are Tier 1/2/3
