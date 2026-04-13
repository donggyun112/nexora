# Public API Surface

Nexora has 17 packages but only **3 official support tiers**. Users should
know which APIs are guaranteed stable and which are internal/advanced.

## Tier 1: Supported (these are the product)

Use these. We won't break them without a major version bump + migration guide.

| Package | What you import | Why |
|---|---|---|
| `@nexora/contracts` | `defineAgent`, `topic`, ID helpers, all interface types | The vocabulary. Everything depends on this. |
| `@nexora/core` | `AgentRunner`, `bootstrapAgent`, `AnthropicProvider`, `OpenAIProvider`, `CoreToolExecutor`, `createSchemaValidator`, `InMemoryBudgetTracker`, `createBudgetMiddleware` | The engine. Runs agents. |
| `@nexora/cli` | `nexora create agent`, `nexora dev`, `nexora export/import` | The DX entry point. |

## Tier 2: Official extensions (stable, but opt-in)

Use when you need the specific capability. Same stability promise as Tier 1.

| Package | When to add |
|---|---|
| `@nexora/transport` | You need Redis, durable delivery, DLQ, or tracing transport |
| `@nexora/context` | You need multi-tenant persona/limits/skills loading |
| `@nexora/tools` | You need builtin tools beyond what you define yourself |
| `@nexora/adapters` | You need HTTP, Discord, Slack, or Paperclip entry points |
| `@nexora/gateway` | You need request routing or SSE streaming |
| `@nexora/orchestrator` | You need workflow chains with checkpoint/resume |
| `@nexora/architectures` | You need ReAct, PlanExecute, DeepResearch, or Loop |

## Tier 3: Advanced / internal (may change)

These exist and work, but they're aimed at framework contributors and
advanced users who are willing to track changes.

| Package | Why it's Tier 3 |
|---|---|
| `@nexora/conversation` | Turn-taking protocol is novel; API surface will likely shrink |
| `@nexora/otel` | Depends on OTel SDK internals; W3C bridge is new |
| `@nexora/store` / `@nexora/store-json` | JSON file stores are dev-only; will be replaced by durable backends |
| `@nexora/registry` | InMemory only; will be replaced or merged into core |

## Rule

When in doubt: **Tier 1 is the answer.** `contracts` + `core` + `cli` gets you
from zero to running agent. Add Tier 2 packages one at a time as you need them.
Never start by importing Tier 3.
