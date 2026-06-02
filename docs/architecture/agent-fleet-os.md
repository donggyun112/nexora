# Nexora as an Agent Fleet Operating System

**Status**: Reasoning note, not an ADR.

**One line**: Nexora is not just an agent framework. It should evolve into the
control plane for an agent fleet, where external frameworks such as OpenClaw,
Hermes, Claude Code workers, MCP servers, or custom HTTP workers are worker
types behind the same capability protocol.

This document captures the structural argument. Decisions that need API or
package commitments should be promoted into `plan/adrs/`.

Related:

- [Agent lifecycle](agent-lifecycle.md)
- [Package spec](package-spec.md)
- [Public API surface](public-api.md)
- [Oracle and syscall contract](oracle-syscall-contract.md)
- [Fleet OS implementation plan](../../plan/roadmap/agent-fleet-os-plan.md)

---

## Starting Point

OpenClaw, Hermes, and similar systems can cover many surface workflows:
keyword research, draft generation, metadata, publishing, and social posts.
Feature-by-feature comparison is therefore the wrong frame. The useful
distinction is structural.

| Category | External single-agent frame | Nexora |
|---|---|---|
| Primary role | Agent runtime or local automation system | Agent fleet control plane |
| Topology | Delegation tree or internal router | Topic/capability-driven event topology |
| Worker ownership | Usually owns the agent loop | May own or only supervise the protocol boundary |
| Completion contract | Text result or framework-specific status | `submit_*` / capability completion contract |
| Human boundary | Local operator or framework-specific session | Adapter/thread/session boundary |
| Routing source of truth | Runtime-specific agent choice | Capability protocol + provider/worker registry |

The decisive difference is:

```text
delegation tree != event-driven fleet topology
```

A delegation tree can ask another agent to help. A fleet topology can admit
multiple runtimes, match work by capability, enforce contracts at the boundary,
trace every transition, and recover consistently when a worker fails.

---

## Product Position

Nexora should be described as:

> The control plane and syscall kernel for an agent fleet. It routes capability
> requests to internal or external workers and validates every state transition
> through protocol, oracle, trace ledger, and completion contracts.

This matters for IN7's narrative because IN7 is about multi-model AI
collaboration. The strongest dogfood story is not "we used one automation
agent"; it is "we operate a mixed fleet of models, frameworks, deterministic
pipelines, and human boundaries through one control plane."

The cluster role is therefore:

```text
OpenClaw / Hermes / personal agents / Nexora native agents
  -> Nexora worker layer
  -> Nexora fleet cluster
  -> capability matching + oracle + trace + submit contract
```

Nexora does not need to own each worker's internal reasoning loop. It owns the
coordination boundary: registration, heartbeat, capability dispatch, tool and
memory syscalls, submit validation, trace propagation, and recovery.

Broadcast is part of that boundary. A Nexora cluster can announce a control
event to eligible workers, fan out work to every worker, race multiple workers
and accept the first valid submit, or wait for a quorum. Side-effecting
broadcasts must preserve `broadcastId`, TTL, idempotency, trace, and submit
validation metadata.

---

## Core Model

The vocabulary must stay separated:

| Term | Meaning |
|---|---|
| Capability | The protocol spec for work that can be requested. Includes input, output, effects, retry, idempotency, evidence, timeout, HITL, and submit contract. |
| Agent/Card | A provider declaration: this runtime can provide these capabilities under these limits and policies. |
| Runtime | The execution strategy behind a card: `react`, `remote`, `deterministic`, `mcp`, `http`, and so on. |
| Worker | A live instance that can receive work. Workers heartbeat, report health, version, in-flight count, and provided capabilities. |
| Oracle | The kernel gate that decides whether proposed actions, tool calls, memory access, submits, retries, and escalations are allowed. |

The important correction is that a card is not the capability spec itself. A
capability says "what work means." A card says "who can perform it and with what
runtime." A worker says "which live instance can do it now."

---

## Reference Flow

```text
External Agent / Internal ReAct Agent / Deterministic Worker
  -> RuntimeAdapter
    -> Nexora envelope
      -> Oracle
      -> Capability Registry
      -> Fleet Registry
      -> Transport
      -> Trace Ledger
      -> Submit Contract
      -> Recovery / DLQ / Escalation
```

External workers do not need to run inside Nexora. They do need to speak the
Nexora protocol at the boundary.

```text
Worker proposes an action.
Nexora decides if the action is allowed.
Nexora routes tool, memory, side-effect, submit, and escalation requests.
Nexora records the trace.
Nexora accepts completion only when the submit contract is satisfied.
```

That is the difference between a message backbone and an operating layer.

---

## Oracle Boundary

Without an oracle, Nexora can be misread as a message bus plus registry. The
oracle is what turns the bus into an agent OS boundary.

The oracle is responsible for:

- Checking whether a capability request is valid for the tenant, goal, budget,
  runtime, and worker.
- Authorizing tool, memory, file, network, publish, and submit actions.
- Validating `submit_*` contracts and required evidence.
- Preserving delegation depth and preventing cycles.
- Deciding retry, repair, DLQ, rollback, or escalation.
- Verifying trace continuity across external adapters.

See [Oracle and syscall contract](oracle-syscall-contract.md) for the first
interface sketch.

---

## External Frameworks as Workers

OpenClaw, Hermes, Claude Code, MCP servers, and custom services should be
positioned as worker kinds, not competitors to the control plane.

```text
[Hermes worker]   [OpenClaw worker]   [Claude Code worker]   [TS/Go worker]
       |                  |                    |                    |
       +------ envelope --+--------- envelope --+--------- envelope --+
                              |
                    [Nexora transport + tracing]
                              |
                    [Nexora oracle + fleet registry]
                              |
                [HTTP / Discord / Slack / scheduler]
```

Each adapter maps Nexora semantics into the external framework:

| Nexora meaning | Adapter responsibility |
|---|---|
| `submit_*` means cycle completion | Translate framework result markers into accepted completion or rejection |
| HITL boundary | Preserve thread, session, or request identity |
| Trace propagation | Carry W3C trace context across calls |
| DLQ classification | Mark retryable and non-retryable failures |
| Delegation depth | Preserve hop metadata across requests |
| Effects | Report which side effects were attempted or completed |

The adapter is where product IP accumulates. It is not just transport glue.

---

## Package Evolution

Current packages already separate contracts, transport, orchestrator, core,
adapters, and OTel. The fleet OS direction extends that separation:

```text
packages/
  contracts/            # add capability protocol, worker, runtime, oracle types
  fleet/                # worker registry, selection, dispatch, broadcast, HTTP invoker
  architectures/
    react.ts            # existing internal loop
    remote.ts           # RuntimeAdapter-based remote execution
    deterministic.ts    # deterministic function/pipeline execution
  adapter-http/         # first general external worker adapter
  adapter-mcp/          # MCP-specific worker/tool bridge
  adapter-hermes/       # later
  adapter-openclaw/     # later
```

For the first proof, prefer `adapter-http` over a framework-specific adapter.
HTTP proves the worker boundary once and lets Hermes, OpenClaw, Claude Code, or
a custom service be wrapped without committing to one external runtime too soon.

---

## Target Authoring Experience

```ts
defineCapability({
  name: 'marketing.long-form-content',
  version: 'v1',
  input: LongFormBriefSchema,
  output: LongFormDraftSchema,
  effects: ['content.write', 'asset.read'],
  idempotency: { key: 'brief.id', scope: 'tenant' },
  retryPolicy: { maxAttempts: 2, backoffMs: 5_000 },
  timeoutMs: 600_000,
  submitContract: 'submit_content',
  hitlPolicy: { optional: true },
  requiredEvidence: ['outline', 'source_notes'],
});

defineAgent({
  name: 'in7-long-form-writer',
  runtime: { kind: 'react', persona: '...', mainSkill: ['long-form-content'] },
  provides: ['marketing.long-form-content@v1'],
});

defineAgent({
  name: 'hermes-long-form-writer',
  runtime: {
    kind: 'remote',
    adapter: 'http',
    target: { url: 'https://worker.example.com/nexora' },
  },
  provides: ['marketing.long-form-content@v1'],
});

dispatch('marketing.long-form-content@v1', brief);
```

The caller dispatches a capability. It does not know or care which runtime is
selected.

---

## Non-Scope

- Nexora should not become a process supervisor. Kubernetes, systemd, Docker,
  and platform schedulers own process lifecycle. Nexora owns discovery,
  matching, policy, protocol, trace, and completion contracts.
- Do not rebuild OpenClaw's task tool pattern inside Nexora. Nexora already has
  stronger topic/capability contracts through transport, registry, and delegate
  primitives.
- Do not start with a full polyglot fleet. First prove one external worker
  boundary.
- Do not let external workers bypass the oracle for tools, memory, side effects,
  or submit decisions.

---

## Conclusion

Cards become capability providers, runtimes become polymorphic, workers become
first-class fleet members, and the oracle becomes the kernel gate. With those
pieces, Nexora stops being only a TypeScript multi-agent framework and becomes
the operating layer for a mixed agent fleet.
