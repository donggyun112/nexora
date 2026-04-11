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
  <a href="docs/architecture/"><strong>Architecture</strong></a> ·
  <a href="https://github.com/donggyun112/nexora"><strong>GitHub</strong></a>
</p>

---

## What is Nexora?

Nexora is a TypeScript framework for running **multiple AI agents as a coordinated team**. Agents communicate via topic pub/sub, serve multiple tenants with isolated contexts, and every action is traceable.

```
curl POST /messages → HttpAdapter → GatewayRouter → Transport
  → Agent (ReAct + tools) → result topic → HTTP response
```

### Why Nexora?

| Problem | Nexora's answer |
|---|---|
| Agents all respond at once in group chat | **Conversation protocol** — agents evaluate relevance, only the best one speaks |
| Agent doesn't know → hallucinates | **Handraise** — agent pauses and asks a human instead of guessing |
| One agent can't do it alone | **Delegate** — agent finds another by capability, not by name |
| Same agent, different customers | **Multi-tenant context** — same binary, different persona/tools/limits per tenant |
| "What did the agent do?" | **OTel tracing** — every tool call, every LLM invocation, one trace in Jaeger |
| Workflow crashes mid-flight | **Checkpoint/resume** — pick up from the last completed step |
| Message lost when subscriber is down | **Redis Streams transport** — at-least-once delivery with consumer groups |

## Quickstart

```bash
# 1. Create an agent
npx @nexora/cli create agent my-agent --tools read,grep

# 2. Wire it up (see docs/getting-started.md for the full 30-line main.ts)

# 3. Send a message
curl -X POST http://localhost:3000/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "What files are in src/?"}'
```

See the [full getting started guide](docs/getting-started.md) and the [helpdesk reference app](examples/helpdesk/).

## Packages

### Stable

| Package | Purpose |
|---|---|
| `@nexora/contracts` | Shared interfaces — the single source of truth |
| `@nexora/core` | AgentRunner, LLM providers (Anthropic/OpenAI/Fallback), ToolExecutor, Compaction, Middleware, Bootstrap, Schema validation, Lint |
| `@nexora/transport` | LocalTransport (dev), RedisTransport (pub/sub), RedisStreamsTransport (durable, consumer groups), TracingTransport |
| `@nexora/context` | PersonaLoader, SkillLoader, TenantConfigStore, CoreContextLoader |
| `@nexora/store` / `@nexora/store-json` | 6-store abstraction (conversation, knowledge, schedule, context, audit, tool-context) + JSON file implementations |
| `@nexora/orchestrator` | WorkflowEngine (retry, goto, timeout, checkpoint/resume) + CronScheduler |
| `@nexora/architectures` | ReAct, Loop, Plan-Execute, Deep Research |
| `@nexora/tools` | ToolRegistry + 9 builtins (exec, read, grep, write, edit, knowledge, web-search, handraise, delegate) + MCP bridge |
| `@nexora/adapters` | HttpAdapter (node:http, no Express) |
| `@nexora/gateway` | GatewayRouter, LocalRuntimeRouter |
| `@nexora/registry` | InMemoryAgentRegistry |
| `@nexora/cli` | `nexora create agent` scaffolding |

### Experimental

| Package | Purpose | Status |
|---|---|---|
| `@nexora/conversation` | Multi-agent group chat turn-taking (evaluate → select → respond → follow-up) | API may change |
| `@nexora/otel` | OpenTelemetry spans for transport + agent execution | Trace parenting uses attributes, not W3C remote parent |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Adapter (HTTP / Discord / Slack)                       │
│    ↓                                                    │
│  Gateway (route by topic / intent)                      │
│    ↓                                                    │
│  Transport (Local / Redis PubSub / Redis Streams)       │
│    ↓                                    ↑               │
│  Bootstrap (auto-subscribe, schema validate, tenant)    │
│    ↓                                    │               │
│  ContextLoader (persona + limits + tools per tenant)    │
│    ↓                                    │               │
│  AgentRunner (architecture loop + middleware)            │
│    ↓                                    │               │
│  Tools (read/grep/exec/handraise/delegate/...)          │
│    ↓                                    │               │
│  Store (conversation/knowledge/audit)   │               │
│                                         │               │
│  Result → publish to topic ─────────────┘               │
└─────────────────────────────────────────────────────────┘
```

## Core Principles

1. **Agents know only contracts, not each other.** Communication via topic pub/sub. No direct agent-to-agent calls.
2. **Same agent, different tenants.** `ContextLoader.load(tenantId)` injects tenant-specific persona, tools, and limits.
3. **Schema at the boundary.** `inputSchema` / `outputSchema` on AgentCard → AJV validation before the agent sees the message.
4. **Workflow is data.** `WorkflowContract` is a declarative JSON structure — versionable, validatable, replayable.
5. **Silence > noise.** In conversation mode, agents that have nothing to add stay quiet.
6. **Ask, don't guess.** The `handraise` tool lets agents pause and request human input instead of hallucinating.

## Multi-tenant

```bash
# Same agent, different customers
curl -H "X-Tenant-Id: startup" -d '{"content": "help"}' ...
curl -H "X-Tenant-Id: enterprise" -d '{"content": "help"}' ...
```

Each tenant gets its own persona, tool allowlist, model selection, and execution limits — loaded from `context/tenants/{id}/`.

## Development

```bash
git clone https://github.com/donggyun112/nexora.git
cd nexora
pnpm install
pnpm build
pnpm test          # 240 tests, all packages
pnpm test:stable   # stable packages only
```

## Security

6 rounds of independent code review (Codex/GPT). Key hardening:
- exec tool: allowList required, 44 interpreter/exec-surface blocklist, version normalization, scrubbed env
- File I/O: O_NOFOLLOW fd-based reads/writes, atomic edit via temp+rename, mode preservation
- Cancellation: AbortSignal plumbed through LLM/tools/architectures, idle timeout kills in-flight work
- Transport: delivery guarantees explicit in type system (`EventTransport` vs `DurableTransport`)

See [safe-path.ts](packages/tools/src/builtin/safe-path.ts) threat model for known limitations.

## License

MIT
