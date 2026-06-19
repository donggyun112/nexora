import type { CapabilityRef } from './capability.js';
import type { NexoraSyscall } from './syscall.js';

export interface OracleContext {
  /** bootstrap에서 resolve된 구체값 (단일 테넌트면 DEFAULT_TENANT). */
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
}

export interface RuntimeState {
  turn?: number;
  inFlight?: number;
  elapsedMs?: number;
  metadata?: Record<string, unknown>;
}

export interface Evidence {
  name: string;
  value: unknown;
  source?: string;
  observedAt?: Date;
}

export interface PolicySnapshot {
  id?: string;
  version?: string;
  rules?: Record<string, unknown>;
}

export interface RuntimeConstraint {
  name: string;
  value: unknown;
}

export interface EventCondition {
  topic?: string;
  timeoutMs?: number;
  description?: string;
}

export type OracleDecision =
  | { decision: 'allow'; constraints?: RuntimeConstraint[] }
  | { decision: 'deny'; reason: string; policyRef?: string }
  | { decision: 'repair'; patch: Partial<NexoraSyscall>; reason: string }
  | { decision: 'defer'; waitFor: EventCondition; reason: string }
  | { decision: 'escalate'; target: 'user' | 'supervisor' | 'operator'; reason: string };

export interface NexoraOracle {
  judge(input: {
    context: OracleContext;
    state: RuntimeState;
    syscall: NexoraSyscall;
    evidence?: Evidence[];
    policy: PolicySnapshot;
  }): Promise<OracleDecision>;
}
