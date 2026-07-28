# authority-attenuation

Deterministic, LLM-free end-to-end demo of **delegation authority attenuation** — the no-escalation invariant from [ADR-004](../../docs/architecture/adrs/adr-004-authority-is-the-moat.md).

## What it shows

A parent agent holds authority `{docs.read, docs.write}` but delegates to a child granting only `{docs.read}`. Using the **real** framework machinery:

```
parent → createDelegateTool({ currentAuthority, authorityForChild })
         stamps attenuate(...) as `inheritedAuthority` onto the hop
       → LocalTransport delivers the envelope
       → child reads envelope.metadata.inheritedAuthority and builds its
         approval gate via createEscalationGuard(inherited)   ← the "consumer" wiring
       → a docs.write tool is DENIED; a docs.read tool runs.
```

The child can never escalate to `docs.write` — enforced at the approval gate, not by convention.

## Run

```bash
pnpm --filter @nexora-examples/authority-attenuation build
pnpm --filter @nexora-examples/authority-attenuation start
# or just the test:
pnpm --filter @nexora-examples/authority-attenuation test
```

Expected output:

```
  Parent authority : docs.read, docs.write
  Granted to child : docs.read            (authorityForChild)
  Child received   : docs.read   ← over the transport hop

  ✓ allowed  docs_read   [docs.read]
  ✗ DENIED   docs_write  [docs.write]

  → The child can never gain docs.write — attenuation enforced at the gate.
```

## The one line that matters

In a real app, the child side is a single wiring line inside `bootstrapAgent`'s `createRuntime({ envelope })`:

```ts
resolveGroupAction: createEscalationGuard(envelope.metadata.inheritedAuthority)
```

That composes the inherited-authority ceiling into the agent's approval gate. The framework (`@dongkseo/tools`) provides `attenuate`, `createEscalationGuard`, and the delegate-side propagation; the app opts in with that line.

Part of the [Nexora](../../README.md) multi-agent runtime.
