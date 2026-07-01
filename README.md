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
  <a href="docs/architecture/packages-map.md"><strong>Package Map</strong></a> ·
  <a href="docs/architecture/"><strong>Architecture</strong></a>
</p>

<p align="center">
  <sub>🤖 Coding agent? Start at <a href="AGENTS.md"><strong>AGENTS.md</strong></a> → <a href="docs/architecture/packages-map.md">packages-map.md</a> for capability → package routing.</sub>
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
@dongkseo/core          — agent runtime + LLM providers
@dongkseo/contracts     — shared types
@dongkseo/transport     — message bus (LocalTransport for dev)
```

That's it. Everything else is optional and added when you need it.

| When you need... | Add... |
|---|---|
| Per-tenant personas and limits | `@dongkseo/context` |
| Workflow chains with retry/checkpoint | `@dongkseo/orchestrator` |
| HTTP API entry point | `@dongkseo/adapters` + `@dongkseo/gateway` |
| Multi-agent conversation (who answers?) | `@dongkseo/conversation` |
| Agent delegates to another agent | `delegate` tool (in `@dongkseo/tools`) |
| Agent asks a human when stuck | `handraise` tool (in `@dongkseo/tools`) |
| Tracing in Jaeger/Tempo | `@dongkseo/otel` |
| Cost control | `BudgetTracker` (in `@dongkseo/core`) |
| Discord/Slack/Paperclip | `@dongkseo/adapters` |
| Scaffold + dev server | `@dongkseo/cli` |
| Self-learning agent skills (YAML+MD) | `@dongkseo/skills` |
| External agents as a worker fleet | `@dongkseo/fleet` |
| Production store (PostgreSQL) | `@dongkseo/store-pg` |
| Plugin-style extensibility | `NexoraExtension` + `ExtensionLoader` (in `@dongkseo/core`) |

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
| OpenClaw/Hermes/custom agents need to collaborate | **Fleet** — register external workers and route by capability |

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
<summary>20 packages (click to expand)</summary>

> Which package for a given task? See the [**package map**](docs/architecture/packages-map.md) — a capability → package routing table with dependency direction and request flow.

| Package | Purpose |
|---|---|
| `@dongkseo/contracts` | Shared interfaces, ID helpers, budget, goal, registry contracts |
| `@dongkseo/core` | AgentRunner, LLM providers, ToolExecutor, Compaction, Middleware, Bootstrap, Schema, Lint, Budget, ExtensionLoader |
| `@dongkseo/transport` | LocalTransport, RedisTransport, RedisStreamsTransport, InMemoryDurableTransport, TracingTransport, DLQTransport |
| `@dongkseo/context` | PersonaLoader, SkillLoader, TenantConfigStore, CoreContextLoader |
| `@dongkseo/store` / `@dongkseo/store-json` | 6-store abstraction + JSON file implementations |
| `@dongkseo/store-pg` | PostgreSQL production store (all 6 stores + session tree + auto-migration) |
| `@dongkseo/orchestrator` | WorkflowEngine (checkpoint/resume) + CronScheduler |
| `@dongkseo/fleet` | Worker registry, capability matching, dispatch, broadcast/fan-out, HTTP worker invoker |
| `@dongkseo/architectures` | ReAct |
| `@dongkseo/tools` | ToolRegistry + ToolsetRegistry + 9 builtins + MCP bridge + handraise + delegate |
| `@dongkseo/skills` | Self-learning skills system (SKILL.md format, SkillLoader, SkillRegistry, SkillCreator) |
| `@dongkseo/conversation` | ConversationRoom, TurnManager (turn-taking protocol) |
| `@dongkseo/otel` | OTelTransport (W3C TraceContext), agent span middleware |
| `@dongkseo/adapters` | HttpAdapter, DiscordAdapter, SlackAdapter, PaperclipAdapter |
| `@dongkseo/gateway` | GatewayRouter, StreamingGatewayRouter, API key auth, rate limiter |
| `@dongkseo/registry` | InMemoryAgentRegistry |
| `@dongkseo/cli` | `create agent`, `dev`, `doctor`, `dlq`, `budget`, `handraise`, `export`, `import` |

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
