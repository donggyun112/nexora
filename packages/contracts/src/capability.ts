import type { RetryPolicy } from './workflow.js';

export type CapabilityRef = string;

export type SubmitContractRef = string;

export type EffectKind =
  | 'read'
  | 'write'
  | 'tool'
  | 'memory'
  | 'network'
  | 'publish'
  | 'submit'
  | 'custom';

export interface EffectSpec {
  name: string;
  kind: EffectKind;
  scope?: string;
  description?: string;
  destructive?: boolean;
  idempotent?: boolean;
}

export interface IdempotencySpec {
  key: string;
  scope: 'tenant' | 'conversation' | 'goal' | 'worker' | 'global';
  ttlMs?: number;
}

export interface HitlPolicy {
  required?: boolean;
  optional?: boolean;
  channel?: 'thread' | 'session' | 'webhook' | 'operator' | 'custom';
  escalationTopic?: string;
}

export interface EvidenceSpec {
  name: string;
  description?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
}

export interface CapabilityProtocol {
  name: string;
  version: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effects?: EffectSpec[];
  idempotency?: IdempotencySpec;
  retryPolicy?: RetryPolicy;
  timeoutMs?: number;
  submitContract?: SubmitContractRef;
  hitlPolicy?: HitlPolicy;
  requiredEvidence?: EvidenceSpec[];
}

export function defineCapability(protocol: CapabilityProtocol): CapabilityProtocol {
  return protocol;
}
