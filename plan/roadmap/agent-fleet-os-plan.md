# Agent Fleet OS Evolution Plan

**Status**: Proposed execution plan.

This plan turns the fleet OS reasoning note into incremental work. The goal is
to prove an external worker boundary without overbuilding a polyglot fleet.

Related:

- [Nexora as an Agent Fleet Operating System](../../docs/architecture/agent-fleet-os.md)
- [Oracle and syscall contract](../../docs/architecture/oracle-syscall-contract.md)
- [ADR-009: self-built agentkit](../adrs/adr-009-self-built-agentkit.md)

---

## Principles

- Start with `adapter-http`; keep Hermes/OpenClaw adapters behind the same
  interface until the boundary is proven.
- Treat Nexora as a control plane, not a process supervisor.
- Keep capability protocol, provider card, runtime, and worker as separate
  concepts.
- Put policy and submit validation at the oracle boundary.
- Make trace and delegation metadata non-optional for worker execution.

---

## Phase 1: Contract Vocabulary

Add contract-only types before implementation packages.

- [x] `CapabilityRef`
- [x] `CapabilityProtocol`
- [x] `RuntimeKind`
- [x] `RuntimeAdapterRef`
- [x] `Worker`
- [x] `WorkerHealth`
- [x] `NexoraSyscall`
- [x] `OracleDecision`
- [x] `NexoraOracle`

Expected package: `packages/contracts`.

Exit criteria:

- Existing `defineAgent` remains backward compatible.
- New types can describe native ReAct providers and remote HTTP providers.
- Type exports are available from `@nexora/contracts`.

---

## Phase 2: HTTP Worker Adapter Proof

Build the smallest external worker boundary.

- [x] Define HTTP worker request and response envelope.
- [x] Add worker registration convention.
- [x] Add heartbeat convention.
- [x] Route one capability request to one registered HTTP worker.
- [ ] Accept `submit` only when output schema and submit contract pass.
- [x] Preserve trace, tenant, conversation, caller, and delegation depth in the invocation request.

Expected packages:

- `packages/contracts`
- `packages/fleet`
- `packages/orchestrator` for later workflow integration

Exit criteria:

- A local HTTP worker can register, receive `dispatch`, and complete a capability.
- A malformed submit is rejected by the oracle path.
- A missing heartbeat degrades the worker.

---

## Phase 3: Fleet Registry

Separate provider declarations from live worker instances.

- [ ] Add `WorkerRegistry` interface.
- [ ] Add in-memory registry implementation.
- [ ] Track health, version, in-flight count, and last heartbeat.
- [ ] Match capability request to eligible workers.
- [ ] Add simple selection policy: healthy first, then lowest in-flight.

Expected package:

- `packages/fleet` or `platform/registry` depending on whether this stays
  library-level or platform-level.

Exit criteria:

- Multiple workers can provide the same capability.
- Down/degraded workers are skipped unless policy allows fallback.

---

## Phase 4: Runtime Polymorphism

Make runtime kind explicit without breaking existing ReAct cards.

- [ ] Extend agent/card definition with optional `runtime`.
- [ ] Keep `architecture: 'react'` as compatibility shorthand.
- [ ] Add remote runtime adapter that delegates execution through the fleet.
- [ ] Add deterministic runtime only if a real pipeline needs it.

Exit criteria:

- Existing examples still compile.
- A card can declare `runtime.kind = 'remote'`.
- Caller still uses `dispatch(capability, input)` without knowing runtime.

---

## Phase 5: External Framework Adapters

Only after Phase 2-4 prove the boundary.

- [ ] Wrap one Hermes or OpenClaw instance through HTTP.
- [ ] Map framework completion to Nexora `submit`.
- [ ] Map framework session/thread identity to Nexora context.
- [ ] Preserve W3C trace context.
- [ ] Classify retryable and non-retryable failures.

Exit criteria:

- External framework can serve one capability without bypassing Nexora policy.
- Nexora trace shows request, adapter call, submit, and completion decision.

---

## Phase 6: Operations

- [ ] Per-adapter DLQ policy.
- [ ] Worker-level OTel attributes.
- [ ] Worker fleet dashboard fields.
- [ ] Canary/fallback policy by capability version.
- [ ] Budget accounting by capability and worker.

Exit criteria:

- Operators can answer: which worker handled this capability, under which
  policy, with what evidence, and why the submit was accepted or denied.

---

## PoC Recommendation

Do Phase 1 and Phase 2 first. Phase 3 is useful if more than one worker instance
is needed during the PoC. Phase 5 should wait until the HTTP boundary has passed
schema, trace, submit, and oracle rejection tests.
