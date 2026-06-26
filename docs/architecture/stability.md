# Package Stability Classification

Every Nexora package is marked as either **stable** or **experimental** in
its `package.json` under `nexora.stability`.

## Stable packages (may only break on major version bumps)

| Package | Purpose |
|---|---|
| `@dongkseo/contracts` | All shared interfaces + defineAgent + ID helpers |
| `@dongkseo/core` | AgentRunner, LLM providers, ToolExecutor, Compaction, Middleware, Bootstrap, Schema validation |
| `@dongkseo/transport` | LocalTransport, RedisTransport, RedisStreamsTransport, TracingTransport |
| `@dongkseo/context` | PersonaLoader, SkillLoader, TenantConfigStore, CoreContextLoader |
| `@dongkseo/store` | Store interface re-export + factory |
| `@dongkseo/store-json` | JSON file store implementations |
| `@dongkseo/orchestrator` | WorkflowEngine + checkpoint/resume + CronScheduler |
| `@dongkseo/architectures` | react |
| `@dongkseo/tools` | ToolRegistry + 9 builtin tools + MCP bridge + handraise + delegate |
| `@dongkseo/adapters` | HttpAdapter |
| `@dongkseo/gateway` | GatewayRouter, LocalRuntimeRouter |
| `@dongkseo/registry` | InMemoryAgentRegistry |
| `@dongkseo/cli` | `nexora create agent` scaffolding |

## Recently promoted to stable

| Package | Was experimental because | Promoted after |
|---|---|---|
| `@dongkseo/conversation` | Concurrency model untested | Round-7: per-room mutex, primary failover, message ownership, evaluate timeout. Round-8: persistence via ConversationStore, maxHistory eviction |
| `@dongkseo/otel` | Trace parenting was attribute-only | Round-8: W3C TraceContext bridge via toW3CTraceId/toW3CSpanId + remote SpanContext construction |

## Experimental packages

None currently. All packages are stable.

## Running tests

```bash
pnpm test              # ALL packages
```

## Rules

1. Stable packages MUST NOT import from experimental packages.
2. Experimental packages MAY import from stable packages.
3. Breaking changes in stable packages require a new major version.
4. Experimental packages may break at any time — users opt in knowingly.
5. Moving a package from experimental to stable is a one-way gate: once stable, always stable (or deprecated).
