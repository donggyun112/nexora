/** Durable, ordered input queue for one agent execution run. */

export type RuntimeInputStatus = 'pending' | 'claimed' | 'admitted' | 'discarded';

export interface RuntimeInputRecord {
  inputId: string;
  status: RuntimeInputStatus;
  value: unknown;
  sequence: number;
}

export interface RuntimeInputQueue {
  /** Append once by caller-supplied id. This operation intentionally needs no run lease. */
  enqueueInput(runId: string, inputId: string, value: unknown): Promise<boolean>;

  /** Return every input in durable submission order. */
  listInputs(runId: string): Promise<RuntimeInputRecord[]>;

  /** Claim a non-terminal input for the active worker; absent inputs are a no-op. */
  claimInput(runId: string, inputId: string, fencingToken?: number): Promise<void>;

  /** Record that selected inputs entered model-visible context. */
  admitInputs(runId: string, inputIds: string[], fencingToken?: number): Promise<void>;

  /** Make screened/cancelled inputs terminal without removing their idempotency keys. */
  discardInputs(runId: string, inputIds: string[], fencingToken?: number): Promise<void>;
}
