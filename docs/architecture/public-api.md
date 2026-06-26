# Public API Surface

Nexora has multiple packages but only **3 official support tiers**. Users should
know which APIs are guaranteed stable and which are internal/advanced.

## Tier 1: Supported (these are the product)

Use these. We won't break them without a major version bump + migration guide.

| Package | What you import | Why |
|---|---|---|
| `@dongkseo/contracts` | `defineAgent`, `topic`, ID helpers, all interface types | The vocabulary. Everything depends on this. |
| `@dongkseo/core` | `AgentRunner`, `bootstrapAgent`, `PiAiProvider`, `FallbackLLMProvider`, `CoreToolExecutor`, `createSchemaValidator`, `InMemoryBudgetTracker`, `createBudgetMiddleware` | The engine. Runs agents. |
| `@dongkseo/cli` | `nexora create agent`, `nexora dev`, `nexora export/import` | The DX entry point. |

## Tier 2: Official extensions (stable, but opt-in)

Use when you need the specific capability. Same stability promise as Tier 1.

| Package | When to add |
|---|---|
| `@dongkseo/transport` | You need Redis, durable delivery, DLQ, or tracing transport |
| `@dongkseo/context` | You need multi-tenant persona/limits/skills loading |
| `@dongkseo/tools` | You need builtin tools beyond what you define yourself |
| `@dongkseo/adapters` | You need HTTP, Discord, Slack, or Paperclip entry points |
| `@dongkseo/gateway` | You need request routing or SSE streaming |
| `@dongkseo/orchestrator` | You need workflow chains with checkpoint/resume |
| `@dongkseo/fleet` | You need external OpenClaw, Hermes, Claude Code, or custom workers in one capability fleet |
| `@dongkseo/architectures` | You need the ReAct architecture (or a base to build a custom one) |

## Tier 3: Advanced / internal (may change)

These exist and work, but they're aimed at framework contributors and
advanced users who are willing to track changes.

| Package | Why it's Tier 3 |
|---|---|
| `@dongkseo/conversation` | Turn-taking protocol is novel; API surface will likely shrink |
| `@dongkseo/otel` | Depends on OTel SDK internals; W3C bridge is new |
| `@dongkseo/store` / `@dongkseo/store-json` | JSON file stores are dev-only; will be replaced by durable backends |
| `@dongkseo/registry` | AgentCard registry only; fleet worker registry lives in `@dongkseo/fleet` |

## Rule

When in doubt: **Tier 1 is the answer.** `contracts` + `core` + `cli` gets you
from zero to running agent. Add Tier 2 packages one at a time as you need them.
Never start by importing Tier 3.
