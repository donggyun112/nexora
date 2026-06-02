# Oracle and Syscall Contract

**Status**: Draft contract.

The oracle is the kernel gate for Nexora's agent fleet. It does not solve the
task. It judges whether a proposed state transition is allowed, denied, repaired,
deferred, or escalated.

Related:

- [Nexora as an Agent Fleet Operating System](agent-fleet-os.md)
- [Agent lifecycle](agent-lifecycle.md)
- [Transport contract](package-spec.md#packagestransport)

---

## Definition

```text
Oracle(context, state, syscall, evidence, policy)
  -> allow | deny | repair | defer | escalate
```

The oracle must be runtime-neutral. A ReAct agent, Hermes worker, OpenClaw
worker, deterministic function, or human-assisted adapter is judged through the
same contract.

---

## Decision Types

```ts
type OracleDecision =
  | { decision: 'allow'; constraints?: RuntimeConstraint[] }
  | { decision: 'deny'; reason: string; policyRef?: string }
  | { decision: 'repair'; patch: Partial<NexoraSyscall>; reason: string }
  | { decision: 'defer'; waitFor: EventCondition; reason: string }
  | { decision: 'escalate'; target: 'user' | 'supervisor' | 'operator'; reason: string };
```

`repair` is for bounded corrections such as adding missing metadata, narrowing a
scope, lowering a timeout, or redirecting to a safer adapter. It must not invent
new task content.

---

## Syscalls

These are the primitive actions that agents and workers request from Nexora.

| Syscall | Meaning |
|---|---|
| `register_worker` | A live worker announces capabilities, adapter kind, version, endpoint, and health. |
| `heartbeat_worker` | A worker reports liveness, in-flight count, degradation, and version. |
| `broadcast` | Propagate a control or work request to multiple eligible workers with `announce`, `fanout`, `race`, or `quorum` mode. |
| `dispatch` | Request a capability asynchronously. |
| `delegate` | Request a capability synchronously or as a child execution while preserving delegation metadata. |
| `tool_call` | Ask Nexora to execute or broker a tool call. |
| `memory_read` | Read memory, knowledge, transcript, or context under a declared scope. |
| `memory_write` | Write memory or audit material with provenance. |
| `publish` | Emit a topic event. |
| `submit` | Claim completion of a capability under a named submit contract. |
| `escalate` | Ask a human, supervisor, or operator to intervene. |
| `retry` | Request another attempt after a classified failure. |
| `dlq` | Route failed work to a dead-letter path with failure class and trace. |

---

## Required Context

Every syscall must carry enough context for the oracle to judge it without
runtime-specific assumptions.

```ts
type OracleContext = {
  tenantId: string;
  conversationId: string;
  traceId: string;
  spanId: string;
  goalId?: string;
  capability?: CapabilityRef;
  callerAgent?: string;
  workerId?: string;
  delegationDepth?: number;
  budgetScope?: string;
  userId?: string;
};
```

Missing context should usually produce `deny` or `repair`, not silent defaults.

---

## Capability Protocol Fields

```ts
type CapabilityProtocol = {
  name: string;
  version: string;
  input: unknown;
  output: unknown;
  effects: EffectSpec[];
  idempotency?: IdempotencySpec;
  retryPolicy?: RetryPolicy;
  timeoutMs: number;
  submitContract: string;
  hitlPolicy?: HitlPolicy;
  requiredEvidence?: EvidenceSpec[];
};
```

Fields that matter most for external workers:

- `effects`: what side effects the worker may ask for.
- `idempotency`: how Nexora avoids duplicate external effects.
- `requiredEvidence`: what must be present before `submit` is accepted.
- `submitContract`: the completion rule, not merely a text answer.
- `timeoutMs` and `retryPolicy`: how recovery is bounded.

---

## Worker Model

```ts
type Worker = {
  id: string;
  adapter: 'native' | 'http' | 'mcp' | 'hermes' | 'openclaw' | 'claude-code';
  provides: CapabilityRef[];
  endpoint: AdapterEndpoint;
  health: 'healthy' | 'degraded' | 'down';
  version: string;
  startedAt: Date;
  lastHeartbeat: Date;
  inFlight: number;
};
```

Nexora should not start or stop worker processes. It should register, match,
route, degrade, and remove workers from service based on protocol signals.

---

## Invariants

The oracle must preserve these invariants:

- A worker cannot access a tool, memory scope, file, network target, or submit
  contract that is outside its capability policy.
- A worker cannot complete a capability without the required evidence.
- A delegated request must preserve `callerAgent`, `delegationDepth`, tenant,
  conversation, and trace metadata.
- Retry must respect idempotency and retry policy.
- DLQ classification must preserve the trace and failure class.
- HITL escalation must preserve the thread/session boundary.
- External adapters must not bypass Nexora for side effects that Nexora is
  expected to audit or budget.

---

## Minimal Interface Sketch

```ts
interface NexoraOracle {
  judge(input: {
    context: OracleContext;
    state: RuntimeState;
    syscall: NexoraSyscall;
    evidence?: Evidence[];
    policy: PolicySnapshot;
  }): Promise<OracleDecision>;
}
```

This interface belongs in `@nexora/contracts` once the draft stabilizes. The
implementation can begin as policy functions in core/orchestrator and later move
behind a dedicated package if the logic becomes large.

---

## First Implementation Target

For the first external worker proof, support only:

- `register_worker`
- `heartbeat_worker`
- `dispatch`
- `submit`
- `tool_call`
- `escalate`

Do not implement all syscall types at once. The first useful test is whether an
HTTP worker can register, receive a capability request, return a submit payload,
and have Nexora accept or reject that completion based on the declared contract.
