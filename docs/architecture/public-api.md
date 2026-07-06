# Public API Surface

Nexora has three support tiers. Prefer the smallest tier that solves the
problem, and do not start new apps by importing advanced or experimental
packages.

## Tier 1: Supported Core

Use these first. We will not break them without a major version bump and a
migration guide.

| Package | What you import | Why |
|---|---|---|
| `@dongkseo/contracts` | `defineAgent`, `topic`, ID helpers, shared interface types | The vocabulary. Everything depends on this. |
| `@dongkseo/core` | `AgentRunner`, `bootstrapAgent`, `PiAiProvider`, `FallbackLLMProvider`, `CoreToolExecutor`, `createSchemaValidator`, `InMemoryBudgetTracker`, `createBudgetMiddleware` | The engine. Runs agents. |
| `@dongkseo/architectures` | `createReactArchitecture` | The default agent loop used by the scaffold. |
| `@dongkseo/cli` | `nexora create agent`, `nexora dev`, `nexora export/import` | The DX entry point. |

## Tier 2: Supported Extensions

Use these when you need the specific capability. They have the same stability
promise as Tier 1.

| Package | When to add |
|---|---|
| `@dongkseo/transport` | You need Redis, durable delivery, DLQ, or tracing transport |
| `@dongkseo/context` | You need multi-tenant persona, limits, skills, or tool allowlist loading |
| `@dongkseo/tools` | You need builtin tools beyond what you define yourself |
| `@dongkseo/adapters` | You need HTTP, Discord, Slack, or Paperclip entry points |
| `@dongkseo/gateway` | You need request routing, auth, rate limiting, or SSE streaming |
| `@dongkseo/registry` | You need AgentCard lookup by name, subscription, or capability |
| `@dongkseo/orchestrator` | You need workflow chains with checkpoint/resume |

## Tier 3: Advanced

These exist and work, but they are aimed at production integrators and
framework contributors willing to track pre-1.0 API movement.

| Package | Why advanced |
|---|---|
| `@dongkseo/conversation` | Turn-taking protocol is novel; API surface may shrink |
| `@dongkseo/fleet` | External worker coordination is newer than the in-process runtime |
| `@dongkseo/otel` | Depends on OTel SDK internals; W3C bridge is new |
| `@dongkseo/store` / `@dongkseo/store-json` | Store factory and dev JSON backend are still evolving |

## Experimental Preview

These packages are intentionally not part of the supported public API yet:
`@dongkseo/skills`, `@dongkseo/sandbox-remote`, `@dongkseo/sandbox-server`,
`@dongkseo/store-memory`, `@dongkseo/store-pg`, and `@dongkseo/tenancy`.

## Rule

When in doubt: Tier 1 is the answer. Add Tier 2 packages one at a time as you
need them. Import Tier 3 or experimental packages only when you accept the
upgrade cost.
