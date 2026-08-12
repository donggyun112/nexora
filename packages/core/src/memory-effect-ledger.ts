import type {
  EffectLedger,
  EffectRecord,
  RuntimeInputQueue,
  RuntimeInputRecord,
} from '@dongkseo/contracts';
import { EffectWriteFencedError } from '@dongkseo/contracts';

interface Lease {
  owner: string;
  token: number;
  expiresAt: number;
}

/** Process-local ledger for tests and development. It is not restart-safe. */
export class MemoryEffectLedger implements EffectLedger, RuntimeInputQueue {
  private readonly effects = new Map<string, EffectRecord>();
  private readonly leases = new Map<string, Lease>();
  private readonly issuedTokens = new Map<string, number>();
  private readonly inputs = new Map<string, RuntimeInputRecord>();
  private readonly inputSequences = new Map<string, number>();

  async read(runId: string, key: string): Promise<EffectRecord> {
    const record = this.effects.get(effectKey(runId, key));
    return record ? structuredClone(record) : { status: 'absent' };
  }

  async start(runId: string, key: string, fencingToken = 0): Promise<boolean> {
    this.assertFence(runId, fencingToken);
    const storageKey = effectKey(runId, key);
    if (this.effects.has(storageKey)) return false;
    this.effects.set(storageKey, { status: 'running' });
    return true;
  }

  async finish(
    runId: string,
    key: string,
    value: unknown,
    fencingToken = 0,
  ): Promise<void> {
    this.assertFence(runId, fencingToken);
    this.effects.set(effectKey(runId, key), {
      status: 'done',
      value: structuredClone(value),
    });
  }

  async forget(runId: string, key: string, fencingToken = 0): Promise<void> {
    this.assertFence(runId, fencingToken);
    const storageKey = effectKey(runId, key);
    if (this.effects.get(storageKey)?.status !== 'done') this.effects.delete(storageKey);
  }

  async acquire(runId: string, owner: string, ttlMs: number): Promise<number> {
    if (!owner) throw new Error('Effect lease owner must not be empty');
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error('Effect lease ttlMs must be a non-negative finite number');
    }

    const now = Date.now();
    const held = this.leases.get(runId);
    if (held?.owner === owner) {
      held.expiresAt = now + ttlMs;
      return held.token;
    }
    if (held && held.expiresAt > now) return 0;

    const token = (this.issuedTokens.get(runId) ?? 0) + 1;
    this.issuedTokens.set(runId, token);
    this.leases.set(runId, { owner, token, expiresAt: now + ttlMs });
    return token;
  }

  async release(runId: string, owner: string): Promise<void> {
    const held = this.leases.get(runId);
    if (held?.owner === owner) {
      this.leases.set(runId, { ...held, owner: '', expiresAt: Date.now() });
    }
  }

  async enqueueInput(runId: string, inputId: string, value: unknown): Promise<boolean> {
    const storageKey = effectKey(runId, inputId);
    if (this.inputs.has(storageKey)) return false;
    const sequence = this.inputSequences.get(runId) ?? 0;
    this.inputSequences.set(runId, sequence + 1);
    this.inputs.set(storageKey, {
      inputId,
      status: 'pending',
      value: structuredClone(value),
      sequence,
    });
    return true;
  }

  async listInputs(runId: string): Promise<RuntimeInputRecord[]> {
    return Array.from(this.inputs.entries())
      .filter(([key]) => key.startsWith(`${runId.length}:${runId}`))
      .map(([, record]) => structuredClone(record))
      .sort((left, right) => left.sequence - right.sequence);
  }

  async claimInput(runId: string, inputId: string, fencingToken = 0): Promise<void> {
    this.assertFence(runId, fencingToken);
    this.transitionInput(runId, inputId, record =>
      record.status === 'admitted' || record.status === 'discarded'
        ? record
        : { ...record, status: 'claimed' });
  }

  async admitInputs(runId: string, inputIds: string[], fencingToken = 0): Promise<void> {
    this.assertFence(runId, fencingToken);
    for (const inputId of inputIds) {
      this.transitionInput(runId, inputId, record =>
        record.status === 'discarded' ? record : { ...record, status: 'admitted' });
    }
  }

  async discardInputs(runId: string, inputIds: string[], fencingToken = 0): Promise<void> {
    this.assertFence(runId, fencingToken);
    for (const inputId of inputIds) {
      this.transitionInput(runId, inputId, record => ({ ...record, status: 'discarded' }));
    }
  }

  private transitionInput(
    runId: string,
    inputId: string,
    transition: (record: RuntimeInputRecord) => RuntimeInputRecord,
  ): void {
    const storageKey = effectKey(runId, inputId);
    const record = this.inputs.get(storageKey);
    if (record) this.inputs.set(storageKey, transition(record));
  }

  private assertFence(runId: string, presentedToken: number): void {
    const issuedToken = this.issuedTokens.get(runId) ?? 0;
    if (presentedToken !== 0 && presentedToken < issuedToken) {
      throw new EffectWriteFencedError(runId, presentedToken, issuedToken);
    }
  }
}

function effectKey(runId: string, key: string): string {
  return `${runId.length}:${runId}${key}`;
}
