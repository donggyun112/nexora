# Package Stability Classification

Every Nexora package is marked as either **stable** or **experimental** in
its `package.json` under `nexora.stability`.

## Stable packages (may only break on major version bumps)

| Package | Purpose |
|---|---|
| `@nexora/contracts` | All shared interfaces + defineAgent + ID helpers |
| `@nexora/core` | AgentRunner, LLM providers, ToolExecutor, Compaction, Middleware, Bootstrap, Schema validation |
| `@nexora/transport` | LocalTransport, RedisTransport, RedisStreamsTransport, TracingTransport |
| `@nexora/context` | PersonaLoader, SkillLoader, TenantConfigStore, CoreContextLoader |
| `@nexora/store` | Store interface re-export + factory |
| `@nexora/store-json` | JSON file store implementations |
| `@nexora/orchestrator` | WorkflowEngine + checkpoint/resume + CronScheduler |
| `@nexora/architectures` | react, loop, plan-execute, deep-research |
| `@nexora/tools` | ToolRegistry + 9 builtin tools + MCP bridge + handraise + delegate |
| `@nexora/adapters` | HttpAdapter |
| `@nexora/gateway` | GatewayRouter, LocalRuntimeRouter |
| `@nexora/registry` | InMemoryAgentRegistry |
| `@nexora/cli` | `nexora create agent` scaffolding |

## Experimental packages (API may change at any time)

| Package | Why experimental | Path to stable |
|---|---|---|
| `@nexora/conversation` | Turn-taking protocol is new, concurrency model untested at scale | Needs: real adapter integration, persistent room state, production load test |
| `@nexora/otel` | OTel trace parenting uses attributes not true remote parent (Nexora UUIDs ≠ W3C TraceContext) | Needs: W3C TraceContext bridge or Nexora ID format alignment |

## Running tests

```bash
pnpm test              # ALL packages (stable + experimental)
pnpm test:stable       # Stable packages only (CI default)
pnpm test:experimental # Experimental packages only
```

## Rules

1. Stable packages MUST NOT import from experimental packages.
2. Experimental packages MAY import from stable packages.
3. Breaking changes in stable packages require a new major version.
4. Experimental packages may break at any time — users opt in knowingly.
5. Moving a package from experimental to stable is a one-way gate: once stable, always stable (or deprecated).
