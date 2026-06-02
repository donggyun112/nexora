import type { CapabilityRef } from './capability.js';
import type { AdapterEndpoint, AdapterKind } from './runtime.js';

export type WorkerHealth = 'healthy' | 'degraded' | 'down';

export interface Worker {
  id: string;
  adapter: AdapterKind;
  provides: CapabilityRef[];
  endpoint: AdapterEndpoint;
  health: WorkerHealth;
  version: string;
  startedAt: Date;
  lastHeartbeat: Date;
  inFlight: number;
  metadata?: Record<string, unknown>;
}

export interface WorkerRegistration {
  id: string;
  adapter: AdapterKind;
  provides: CapabilityRef[];
  endpoint: AdapterEndpoint;
  version: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerHeartbeat {
  workerId: string;
  health: WorkerHealth;
  inFlight?: number;
  version?: string;
  observedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface WorkerRegistry {
  register(worker: WorkerRegistration): Promise<Worker>;
  heartbeat(heartbeat: WorkerHeartbeat): Promise<Worker | null>;
  unregister(workerId: string): Promise<void>;
  get(workerId: string): Promise<Worker | null>;
  list(): Promise<Worker[]>;
  findByCapability(capability: CapabilityRef): Promise<Worker[]>;
}
