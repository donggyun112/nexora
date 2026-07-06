# Package Stability Classification

Every Nexora package declares its support level in `package.json` under
`nexora.stability`. Valid values are **stable**, **advanced**, and
**experimental**.

## Stable packages

Stable packages are the supported product surface. Breaking changes require a
major version bump and a migration note.

| Package | Purpose |
|---|---|
| `@dongkseo/contracts` | Shared interfaces, `defineAgent`, topics, ID helpers |
| `@dongkseo/core` | Agent runtime, LLM providers, tool executor, compaction, middleware, bootstrap, schema validation |
| `@dongkseo/transport` | Local, Redis, Redis Streams, tracing, DLQ transport |
| `@dongkseo/context` | Persona, tenant config, limits, and tool allowlist loading |
| `@dongkseo/orchestrator` | WorkflowEngine, checkpoint/resume, CronScheduler |
| `@dongkseo/architectures` | ReAct architecture |
| `@dongkseo/tools` | ToolRegistry, builtin tools, MCP bridge, handraise, delegate |
| `@dongkseo/adapters` | HTTP, Discord, Slack, Paperclip adapters |
| `@dongkseo/gateway` | GatewayRouter, LocalRuntimeRouter, streaming, auth, rate limit |
| `@dongkseo/registry` | AgentCard registry, Redis registry, capability registry |
| `@dongkseo/cli` | `nexora` scaffolding, dev server, operations commands |

## Advanced packages

Advanced packages work, but are aimed at production integrators and framework
contributors. API shape may still shrink before 1.0.

| Package | Why advanced |
|---|---|
| `@dongkseo/conversation` | Turn-taking protocol and persistence boundary are still being hardened |
| `@dongkseo/fleet` | External worker coordination is newer than the in-process runtime |
| `@dongkseo/otel` | Depends on OTel SDK details and W3C trace bridging |
| `@dongkseo/store` | Store factory and backend selection are still evolving |
| `@dongkseo/store-json` | Useful dev backend, not the durable production backend |

## Experimental packages

Experimental packages are preview surfaces. They may change without a major
version bump while the runtime contracts settle.

| Package | Why experimental |
|---|---|
| `@dongkseo/skills` | Self-learning skill lifecycle and prompt menu policy are still evolving |
| `@dongkseo/sandbox-remote` | Remote sandbox wire client is new |
| `@dongkseo/sandbox-server` | Reference sandbox wire server is new |
| `@dongkseo/store-memory` | In-memory graph/embedding store is not durable |
| `@dongkseo/store-pg` | PostgreSQL backend still needs integration hardening |
| `@dongkseo/tenancy` | Opt-in tenant boundary helpers are still being validated |

## Running tests

```bash
pnpm test              # ALL packages
pnpm test:stable       # stable package set
pnpm test:experimental # advanced + experimental package set
```

## Rules

1. Stable packages MUST NOT have required runtime dependencies on advanced or experimental packages.
2. Stable packages MAY expose optional integrations backed by advanced or experimental packages only when the dependency is an optional peer and is loaded lazily.
3. Advanced packages MAY depend on stable packages and other advanced packages.
4. Experimental packages MAY depend on stable, advanced, or experimental packages.
5. Package README stability labels, `package.json` metadata, and `public-api.md` must be updated in the same change.
6. Moving a package from experimental or advanced to stable is a one-way gate: once stable, it is either kept stable or deprecated.
