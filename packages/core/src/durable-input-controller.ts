import type {
  RuntimeInputQueue,
  RuntimeInputRecord,
} from '@dongkseo/contracts';
import { RunLeaseContendedError } from './durable-tool-executor.js';

export interface DurableInputControllerOptions {
  queue: RuntimeInputQueue;
  runId: string;
  fencingToken: number;
  /** Renew the active run lease before a protected queue transition. */
  renewLease?: () => Promise<number>;
}

/** Runtime-owned admission boundary over the durable input queue. */
export class DurableInputController {
  private fencingToken: number;
  private readonly seen = new Set<string>();

  constructor(private readonly options: DurableInputControllerOptions) {
    if (!options.runId) throw new Error('DurableInputController runId must not be empty');
    this.fencingToken = options.fencingToken;
  }

  /** Append external input without taking the run lease. Safe while a worker is active. */
  async submit(inputId: string, value: unknown): Promise<boolean> {
    if (!inputId) throw new Error('Durable input id must not be empty');
    return this.options.queue.enqueueInput(this.options.runId, inputId, value);
  }

  /**
   * Claim every unrepresented, non-discarded input in submission order.
   * Admitted rows are deliberately replayed when no transcript/history represents them.
   */
  async claim(representedIds: ReadonlySet<string> = new Set()): Promise<RuntimeInputRecord[]> {
    const records = await this.options.queue.listInputs(this.options.runId);
    const selected = records.filter(record =>
      record.status !== 'discarded'
      && !representedIds.has(record.inputId)
      && !this.seen.has(record.inputId));
    if (selected.length === 0) return [];

    await this.renew();
    for (const record of selected) {
      await this.options.queue.claimInput(
        this.options.runId,
        record.inputId,
        this.fencingToken,
      );
      this.seen.add(record.inputId);
    }
    return selected.map(record => structuredClone(record));
  }

  /** Commit that the selected queue rows entered model-visible context. */
  async admit(inputs: readonly (RuntimeInputRecord | string)[]): Promise<void> {
    const inputIds = idsOf(inputs);
    if (inputIds.length === 0) return;
    await this.renew();
    await this.options.queue.admitInputs(this.options.runId, inputIds, this.fencingToken);
  }

  /** Commit that policy screened the selected rows out of model-visible context. */
  async discard(inputs: readonly (RuntimeInputRecord | string)[]): Promise<void> {
    const inputIds = idsOf(inputs);
    if (inputIds.length === 0) return;
    await this.renew();
    await this.options.queue.discardInputs(this.options.runId, inputIds, this.fencingToken);
  }

  private async renew(): Promise<void> {
    if (!this.options.renewLease) return;
    const token = await this.options.renewLease();
    if (token === 0) throw new RunLeaseContendedError(this.options.runId);
    this.fencingToken = token;
  }
}

function idsOf(inputs: readonly (RuntimeInputRecord | string)[]): string[] {
  return inputs.map(input => typeof input === 'string' ? input : input.inputId);
}
