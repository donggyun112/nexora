import type { CapabilityRef } from './capability.js';
import type { Evidence, OracleContext } from './oracle.js';
import type { Worker } from './worker.js';

export interface WorkerInvocationRequest {
  id: string;
  context: OracleContext;
  capability: CapabilityRef;
  input: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export type WorkerInvocationResult =
  | WorkerSubmitResult
  | WorkerEscalationResult
  | WorkerErrorResult;

export interface WorkerSubmitResult {
  type: 'submit';
  contract: string;
  output: unknown;
  evidence?: Evidence[];
  metadata?: Record<string, unknown>;
}

export interface WorkerEscalationResult {
  type: 'escalate';
  reason: string;
  target?: 'user' | 'supervisor' | 'operator';
  evidence?: Evidence[];
  metadata?: Record<string, unknown>;
}

export interface WorkerErrorResult {
  type: 'error';
  message: string;
  retryable?: boolean;
  evidence?: Evidence[];
  metadata?: Record<string, unknown>;
}

export interface WorkerInvoker {
  invoke(worker: Worker, request: WorkerInvocationRequest): Promise<WorkerInvocationResult>;
}
