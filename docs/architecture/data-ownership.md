# Data Ownership Table

Every piece of data in Nexora belongs to exactly ONE of four categories.
The rule: **single writer, many readers**. If two components can write
the same data, you have a bug.

## Categories

| Category | Who writes | Who reads | Survives restart? | Examples |
|---|---|---|---|---|
| **Agent-local** | The agent instance | Only that agent | Per-session (lost on restart unless checkpointed) | In-memory conversation history, current tool call state, evaluate confidence |
| **Tenant-shared (read-only)** | Operator/admin at deploy time | All agents for that tenant | Yes (files/config) | Persona files, tenant.json, skills/, common.md, tool allowlists |
| **Workflow-state** | WorkflowEngine only | Engine + resume logic | Yes (via WorkflowStateStore) | Step results, checkpoint, nextStepId, initial input |
| **External system of record** | Store implementation | Anyone via Store interface | Yes (by definition) | ConversationStore, KnowledgeStore, AuditStore, ScheduleStore |

## Per-data-type classification

### Agent Runtime

| Data | Category | Writer | Notes |
|---|---|---|---|
| `AgentRunner` execution state | Agent-local | AgentRunner | Lost on crash. Restored by re-execute, not by deserialization. |
| `RuntimeServices.signal` | Agent-local | AgentRunner (AbortController) | Per-execution. |
| `MemoryProvider` in-memory cache | Agent-local | CoreMemoryProvider | Backed by ConversationStore (external). Cache is acceleration only. |
| Middleware pipeline state | Agent-local | MiddlewarePipeline | Stateless between executions. |

### Context (tenant config)

| Data | Category | Writer | Notes |
|---|---|---|---|
| `personas/{agent}.md` | Tenant-shared read-only | Operator | Loaded by PersonaLoader. Never written by agents. |
| `tenants/{id}/tenant.json` | Tenant-shared read-only | Operator | Limits, tool allowlists, extra context. |
| `skills/*.md` | Tenant-shared read-only | Operator | Skill definitions. |
| `common.md` | Tenant-shared read-only | Operator | Company-wide context. |
| `AgentContext` (assembled) | Agent-local | ContextLoader.load() | Built per-request from tenant-shared sources. Ephemeral. |

### Transport

| Data | Category | Writer | Notes |
|---|---|---|---|
| `MessageEnvelope` | Agent-local (in transit) | Publisher | Envelopes are ephemeral. Once delivered + ack'd, gone. |
| `MessageEnvelope` in Redis Stream | External system of record | RedisStreamsTransport | Persisted until XACK. Redis is the system of record. |
| Subscription state | Agent-local | Transport instance | Lost on restart. Agents re-subscribe via bootstrapAgent(). |

### Stores (persistence)

| Data | Category | Writer | Notes |
|---|---|---|---|
| `ConversationStore` | External system of record | CoreMemoryProvider (single writer per conversationId) | JSON files, future: Postgres. |
| `KnowledgeStore` | External system of record | Knowledge tool (single writer per namespace+topic) | Markdown files. |
| `ScheduleStore` | External system of record | Schedule tool | JSON files. |
| `ContextStore` | External system of record | Daily context generator | JSON files. |
| `AuditStore` | External system of record | Bootstrap (append-only) | JSONL files. |
| `ToolContextStore` | External system of record | CoreToolExecutor | JSONL files. TTL-based cleanup. |

### Workflow

| Data | Category | Writer | Notes |
|---|---|---|---|
| `WorkflowContract` | Tenant-shared read-only | Operator | Declarative. Never modified at runtime. |
| `WorkflowCheckpoint` | Workflow-state | WorkflowEngine only | InMemoryWorkflowStateStore or persistent impl. |
| Step results (`Map<stepId, result>`) | Workflow-state | WorkflowEngine only | Serialized into checkpoint. |

### Conversation (experimental)

| Data | Category | Writer | Notes |
|---|---|---|---|
| `ConversationRoom.messages` | Agent-local | TurnManager only | In-memory. Lost on restart. Future: persist to ConversationStore. |
| `ConversationRoom.participants` | Agent-local | join()/leave() | In-memory. Re-built on restart. |
| `ConversationRoom.activeResponder` | Agent-local | TurnManager | Mutex state. Cleaned up in finally. |
| Evaluate results | Agent-local | evaluateAll() | Ephemeral per-turn. Not persisted. |

### Registry

| Data | Category | Writer | Notes |
|---|---|---|---|
| `AgentCard` | Tenant-shared read-only (definition) + External (registration) | defineAgent() creates, bootstrapAgent() registers | Card definition is static. Registration is dynamic but agent-owns-its-own-card. |
| `InMemoryAgentRegistry` state | Agent-local | bootstrapAgent register/unregister | Lost on restart. Agents re-register on boot. |

## Invariants

1. **No two components write the same data** — if ConversationStore is written by CoreMemoryProvider, no other component may write to the same conversationId.
2. **Tenant-shared data is read-only at runtime** — agents never modify persona files, skills, or tenant config.
3. **Workflow state is owned exclusively by WorkflowEngine** — agents do not read or write checkpoints directly.
4. **External stores are the source of truth** — in-memory caches (MemoryProvider cache, Registry Map) are acceleration layers, not authorities. On conflict, the store wins.
5. **Envelopes are ephemeral** — transport delivers, receiver processes, envelope is gone. The only durable representation is in DurableTransport (Redis Streams) or in the Store that the handler writes to.
