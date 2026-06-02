import type { CapabilityRef } from './capability.js';
import type { MessageEnvelope } from './message.js';
import type { ToolBatchCall } from './agent.js';
import type { WorkerHeartbeat, WorkerRegistration } from './worker.js';

export type NexoraSyscall =
  | RegisterWorkerSyscall
  | HeartbeatWorkerSyscall
  | DispatchSyscall
  | DelegateSyscall
  | ToolCallSyscall
  | MemoryReadSyscall
  | MemoryWriteSyscall
  | PublishSyscall
  | SubmitSyscall
  | EscalateSyscall
  | RetrySyscall
  | DlqSyscall;

export interface RegisterWorkerSyscall {
  type: 'register_worker';
  worker: WorkerRegistration;
}

export interface HeartbeatWorkerSyscall {
  type: 'heartbeat_worker';
  heartbeat: WorkerHeartbeat;
}

export interface DispatchSyscall {
  type: 'dispatch';
  capability: CapabilityRef;
  input: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export interface DelegateSyscall {
  type: 'delegate';
  capability: CapabilityRef;
  input: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export interface ToolCallSyscall {
  type: 'tool_call';
  call: ToolBatchCall;
}

export interface MemoryReadSyscall {
  type: 'memory_read';
  query: unknown;
  scope: string;
}

export interface MemoryWriteSyscall {
  type: 'memory_write';
  record: unknown;
  scope: string;
}

export interface PublishSyscall {
  type: 'publish';
  envelope: MessageEnvelope;
}

export interface SubmitSyscall {
  type: 'submit';
  capability: CapabilityRef;
  contract: string;
  output: unknown;
  evidence?: unknown[];
}

export interface EscalateSyscall {
  type: 'escalate';
  reason: string;
  target?: 'user' | 'supervisor' | 'operator';
}

export interface RetrySyscall {
  type: 'retry';
  reason: string;
  attempt: number;
  maxAttempts: number;
}

export interface DlqSyscall {
  type: 'dlq';
  reason: string;
  failureClass: 'retryable' | 'non_retryable' | 'policy' | 'timeout' | 'unknown';
  envelope?: MessageEnvelope;
}
