/**
 * Durable effect ledger contract.
 *
 * An implementation must commit `start` before an external effect executes and
 * `finish` after its result is durable. A `running` record therefore means the
 * effect may or may not have happened; callers must not silently execute it
 * again.
 */

export type EffectRecord =
  | { status: 'absent' }
  | { status: 'running' }
  | { status: 'done'; value: unknown };

export interface EffectLedger {
  /** Return the persisted state of one effect. */
  read(runId: string, key: string): Promise<EffectRecord>;

  /** Atomically insert running intent when the effect is absent. */
  start(runId: string, key: string, fencingToken?: number): Promise<boolean>;

  /** Persist the completed result after validating the fencing token. */
  finish(runId: string, key: string, value: unknown, fencingToken?: number): Promise<void>;

  /**
   * Remove uncompleted intent after an effect proves that no output became
   * visible. Completed effects must be preserved.
   */
  forget(runId: string, key: string, fencingToken?: number): Promise<void>;

  /**
   * Acquire or renew a run lease. Returns its positive fencing token, or zero
   * when another owner currently holds the lease.
   */
  acquire(runId: string, owner: string, ttlMs: number): Promise<number>;

  /** Release a run lease held by `owner` without resetting its fencing token. */
  release(runId: string, owner: string): Promise<void>;
}

/** A lease-protected write arrived after a newer worker took ownership. */
export class EffectWriteFencedError extends Error {
  constructor(
    public readonly runId: string,
    public readonly presentedToken: number,
    public readonly issuedToken: number,
  ) {
    super(
      `Run ${JSON.stringify(runId)} moved on: write presented fencing token `
      + `${presentedToken}, current token is ${issuedToken}`,
    );
    this.name = 'EffectWriteFencedError';
  }
}
