<p align="center">
  <strong>Nexora</strong>
</p>

<p align="center">
  Multi-tenant agent framework for TypeScript.<br/>
  Multiple AI agents, one team, every tenant isolated.
</p>

<p align="center">
  <a href="docs/getting-started.md"><strong>Getting Started</strong></a> ·
  <a href="examples/helpdesk/"><strong>Reference App</strong></a> ·
  <a href="examples/personal-assistant/"><strong>OpenClaw-style Demo</strong></a> ·
  <a href="docs/architecture/"><strong>Architecture</strong></a>
</p>

> **v0.1** — The core works and is tested (344 tests). APIs may still change before 1.0. Feedback welcome.

---

## What is Nexora?

Nexora is a TypeScript framework for running **multiple AI agents as a coordinated team**.

```
nexora create agent my-agent
nexora dev
curl localhost:3000/messages -d '{"content": "hello"}'
```

## Start here

You only need **3 packages** to run your first agent:

```
@nexora/core          — agent runtime + LLM providers
@nexora/contracts     — shared types
@nexora/transport     — message bus (LocalTransport for dev)
```

That's it. Everything else is optional and added when you need it.

| When you need... | Add... |
|---|---|
| Per-tenant personas and limits | `@nexora/context` |
| Workflow chains with retry/checkpoint | `@nexora/orchestrator` |
| HTTP API entry point | `@nexora/adapters` + `@nexora/gateway` |
| Multi-agent conversation (who answers?) | `@nexora/conversation` |
| Agent delegates to another agent | `delegate` tool (in `@nexora/tools`) |
| Agent asks a human when stuck | `handraise` tool (in `@nexora/tools`) |
| Tracing in Jaeger/Tempo | `@nexora/otel` |
| Cost control | `BudgetTracker` (in `@nexora/core`) |
| Discord/Slack/Paperclip | `@nexora/adapters` |
| Scaffold + dev server | `@nexora/cli` |
| Self-learning agent skills (YAML+MD) | `@nexora/skills` |
| Production store (PostgreSQL) | `@nexora/store-pg` |
| Plugin-style extensibility | `NexoraExtension` + `ExtensionLoader` (in `@nexora/core`) |

See the [full getting started guide](docs/getting-started.md) — zero to running agent in 5 steps.

## Why Nexora?

| Problem | Nexora's answer |
|---|---|
| Agents all respond at once in group chat | **Conversation protocol** — agents evaluate relevance, best one speaks |
| Agent doesn't know → hallucinates | **Handraise** — pause and ask a human instead of guessing |
| One agent can't do it alone | **Delegate** — find another by capability, not by name |
| Same agent, different customers | **Multi-tenant context** — same binary, different persona/tools/limits |
| "What did the agent do?" | **OTel tracing** — every call, one trace in Jaeger |
| Workflow crashes mid-flight | **Checkpoint/resume** — pick up from the last step |
| LLM costs spiral | **Budget tracking** — per-agent/tenant limits with block/warn |
| Agent keeps making the same mistake | **Skills** — agent self-creates reusable SKILL.md files |
| LLM provider goes down | **Smart fallback** — error classification + automatic retry on another provider |

### Can I build OpenClaw with this?

[Yes. Here's the 30-line version.](examples/personal-assistant/)

## Architecture

```
Adapter (HTTP / Discord / Slack)
  → Gateway (auth + rate limiter → route by topic)
    → Transport (Local / Redis / InMemoryDurable)
      → Bootstrap (subscribe, validate, tenant)
        → ContextLoader (persona + limits + tools)
          → AgentRunner (ReAct)
            → Tools (read / grep / exec / handraise / delegate)
            → Skills (SKILL.md — self-learning, auto-created)
            → Store (conversation / knowledge / audit → JSON or PostgreSQL)
          → Result → publish to topic
```

## All packages

<details>
<summary>19 packages (click to expand)</summary>

| Package | Purpose |
|---|---|
| `@nexora/contracts` | Shared interfaces, ID helpers, budget, goal, registry contracts |
| `@nexora/core` | AgentRunner, LLM providers, ToolExecutor, Compaction, Middleware, Bootstrap, Schema, Lint, Budget, ExtensionLoader |
| `@nexora/transport` | LocalTransport, RedisTransport, RedisStreamsTransport, InMemoryDurableTransport, TracingTransport, DLQTransport |
| `@nexora/context` | PersonaLoader, SkillLoader, TenantConfigStore, CoreContextLoader |
| `@nexora/store` / `@nexora/store-json` | 6-store abstraction + JSON file implementations |
| `@nexora/store-pg` | PostgreSQL production store (all 6 stores + session tree + auto-migration) |
| `@nexora/orchestrator` | WorkflowEngine (checkpoint/resume) + CronScheduler |
| `@nexora/architectures` | ReAct |
| `@nexora/tools` | ToolRegistry + ToolsetRegistry + 9 builtins + MCP bridge + handraise + delegate |
| `@nexora/skills` | Self-learning skills system (SKILL.md format, SkillLoader, SkillRegistry, SkillCreator) |
| `@nexora/conversation` | ConversationRoom, TurnManager (turn-taking protocol) |
| `@nexora/otel` | OTelTransport (W3C TraceContext), agent span middleware |
| `@nexora/adapters` | HttpAdapter, DiscordAdapter, SlackAdapter, PaperclipAdapter |
| `@nexora/gateway` | GatewayRouter, StreamingGatewayRouter, API key auth, rate limiter |
| `@nexora/registry` | InMemoryAgentRegistry |
| `@nexora/cli` | `create agent`, `dev`, `doctor`, `dlq`, `budget`, `handraise`, `export`, `import` |

</details>

## Multi-tenant

```bash
curl -H "X-Tenant-Id: startup" -d '{"content": "help"}' ...
curl -H "X-Tenant-Id: enterprise" -d '{"content": "help"}' ...
```

Each tenant gets its own persona, tool allowlist, model, limits, and budget.

## Examples

| Example | What it shows |
|---|---|
| [helpdesk](examples/helpdesk/) | Full-stack E2E: HTTP → Agent → Tools → Reply. Multi-tenant. |
| [personal-assistant](examples/personal-assistant/) | OpenClaw-style 1:1 companion in 30 lines. |

## Development

```bash
git clone https://github.com/donggyun112/nexora.git
cd nexora && pnpm install && pnpm build && pnpm test
```

## Security

Exec sandbox (allowList + interpreter block), fd-based file I/O (O_NOFOLLOW), AbortSignal cancellation, typed transport guarantees, budget enforcement, import path validation, delegation cycle detection, tool pair sanitization, gateway API key auth + rate limiting (429), LLM error classification + smart fallback, skill content threat scanning.

## Status

This is **v0.1** — the architecture is proven and the tests pass, but the APIs are not frozen. We expect breaking changes before 1.0 based on real-world usage feedback.

## License

MIT
