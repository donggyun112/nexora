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
| Message lost when subscriber is down | **Durable transport** — at-least-once delivery with consumer groups (Redis Streams or in-memory) |
| LLM costs spiral out of control | **Budget tracking** — per-agent, per-tenant cost limits with block/warn/pause |
| Failed messages disappear | **DLQ + idempotency** — dead letter queue captures failures, dedup prevents retries |
| "Why is the agent doing this?" | **Goal hierarchy** — every task traces back to a company goal |

### Can I build OpenClaw with this?

[Yes. Here's the 30-line version.](examples/personal-assistant/)

## Quickstart

```bash
# 1. Create an agent
npx @nexora/cli create agent my-agent --tools read,grep

# 2. Start everything
npx @nexora/cli dev

# 3. Send a message
curl -X POST http://localhost:3000/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "What files are in src/?"}'
```

See the [full getting started guide](docs/getting-started.md) and the [helpdesk reference app](examples/helpdesk/).

## Packages (17, all stable)

| Package | Purpose |
|---|---|
| `@nexora/contracts` | Shared interfaces, ID helpers, budget, goal, workflow-state, registry contracts |
| `@nexora/core` | AgentRunner, LLM providers (Anthropic/OpenAI/Fallback), ToolExecutor, Compaction, Middleware, Bootstrap, Schema validation, Lint, BudgetTracker |
| `@nexora/transport` | LocalTransport, RedisTransport (pub/sub), RedisStreamsTransport (durable), **InMemoryDurableTransport** (no Redis needed), TracingTransport, DLQTransport |
| `@nexora/context` | PersonaLoader, SkillLoader, TenantConfigStore, CoreContextLoader |
| `@nexora/store` / `@nexora/store-json` | 6-store abstraction + JSON file implementations |
| `@nexora/orchestrator` | WorkflowEngine (retry, goto, timeout, **checkpoint/resume**) + CronScheduler |
| `@nexora/architectures` | ReAct, Loop, Plan-Execute, Deep Research |
| `@nexora/tools` | ToolRegistry + 9 builtins (exec, read, grep, write, edit, knowledge, web-search, **handraise**, **delegate**) + MCP bridge |
| `@nexora/conversation` | ConversationRoom (persistent), TurnManager (mutex, failover, evaluate timeout) |
| `@nexora/otel` | OTelTransport (W3C TraceContext), agent execution + tool call spans |
| `@nexora/adapters` | **HttpAdapter**, **DiscordAdapter**, **SlackAdapter**, **PaperclipAdapter** |
| `@nexora/gateway` | GatewayRouter, LocalRuntimeRouter, **StreamingGatewayRouter** (true SSE) |
| `@nexora/registry` | InMemoryAgentRegistry |
| `@nexora/cli` | `create agent`, `dev`, `export`, `import` |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Adapter (HTTP / Discord / Slack / Paperclip)            │
│    ↓                                                     │
│  Gateway (route by topic / intent / streaming)           │
│    ↓                                                     │
│  Transport (Local / Redis / InMemoryDurable / DLQ)       │
│    ↓                                     ↑               │
│  Bootstrap (subscribe, schema, tenant, lint, budget)     │
│    ↓                                     │               │
│  ContextLoader (persona + limits + tools + goals)        │
│    ↓                                     │               │
│  AgentRunner (architecture loop + middleware + abort)     │
│    ↓                                     │               │
│  Tools (read/grep/exec/handraise/delegate/...)           │
│    ↓                                     │               │
│  Store (conversation/knowledge/audit)    │               │
│                                          │               │
│  Result → publish to topic ──────────────┘               │
│                                                          │
│  ┌─ Conversation Protocol ─────────────────────────┐     │
│  │ Evaluate (50 tokens) → Select → Respond → Follow│     │
│  └─────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────┘
```

## Core Principles

1. **Agents know only contracts, not each other.** Communication via topic pub/sub. No direct agent-to-agent calls.
2. **Same agent, different tenants.** `ContextLoader.load(tenantId)` injects tenant-specific persona, tools, and limits.
3. **Schema at the boundary.** `inputSchema`/`outputSchema` on AgentCard → AJV validation before the agent runs.
4. **Workflow is data.** `WorkflowContract` is declarative JSON — versionable, validatable, replayable.
5. **Silence > noise.** In conversation mode, agents that have nothing to add stay quiet.
6. **Ask, don't guess.** `handraise` lets agents pause and request human input instead of hallucinating.
7. **Redis is optional.** `InMemoryDurableTransport` provides at-least-once delivery without external deps.

## Multi-tenant

```bash
curl -H "X-Tenant-Id: startup" -d '{"content": "help"}' ...
curl -H "X-Tenant-Id: enterprise" -d '{"content": "help"}' ...
```

Each tenant gets its own persona, tool allowlist, model, execution limits, and budget — loaded from `context/tenants/{id}/`.

## Examples

| Example | What it proves |
|---|---|
| [helpdesk](examples/helpdesk/) | Full-stack E2E: HTTP → Gateway → Transport → Agent → Tool → Reply. Multi-tenant. 5 tests. |
| [personal-assistant](examples/personal-assistant/) | OpenClaw-style 1:1 companion in 30 lines. Conversation + budget. 3 tests. |

## Development

```bash
git clone https://github.com/donggyun112/nexora.git
cd nexora
pnpm install
pnpm build
pnpm test          # 274 tests, 17 packages, 32 turbo tasks
```

## Security

9 rounds of independent code review (Codex/GPT). Key hardening:
- **exec**: allowList required, 44 interpreter blocklist, version normalization, scrubbed env
- **File I/O**: O_NOFOLLOW fd-based reads/writes, atomic edit via temp+rename, mode preservation
- **Cancellation**: AbortSignal plumbed through LLM/tools/architectures, idle timeout kills in-flight work
- **Transport**: delivery guarantees explicit in type system (`EventTransport` vs `DurableTransport`)
- **Budget**: per-agent/tenant cost limits, pre-execution block on exceeded policies
- **Import**: tar member path validation prevents traversal/escape
- **Delegation**: cross-process cycle detection via envelope metadata depth counter

See [safe-path.ts](packages/tools/src/builtin/safe-path.ts) threat model for known limitations.

## License

MIT
