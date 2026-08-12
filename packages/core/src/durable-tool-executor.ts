import { createHash } from 'node:crypto';
import type {
  EffectLedger,
  ToolBatchCall,
  ToolBatchResult,
  ToolContext,
  ToolDefinition,
  ToolDefinitionSummary,
  ToolExecutor,
  ToolResult,
} from '@dongkseo/contracts';
import { OrchestrationControlError } from '@dongkseo/contracts';

interface StoredToolEffect {
  version: 1;
  kind: 'tool';
  name: string;
  inputFingerprint: string;
  result: unknown;
}

export interface DurableToolExecutorOptions {
  inner: ToolExecutor;
  ledger: EffectLedger;
  runId: string;
  fencingToken: number;
  /** Renew the enclosing run lease immediately before a new effect starts. */
  renewLease?: () => Promise<number>;
}

export class DurableExecutionError extends OrchestrationControlError {}

/** An interrupted effect has intent but no committed result. */
export class IndeterminateEffectError extends DurableExecutionError {
  constructor(
    public readonly runId: string,
    public readonly effectKey: string,
  ) {
    super(`Effect ${JSON.stringify(effectKey)} of run ${JSON.stringify(runId)} may have happened`);
    this.name = 'IndeterminateEffectError';
  }
}

/** Another worker owns the run lease. */
export class RunLeaseContendedError extends DurableExecutionError {
  constructor(public readonly runId: string) {
    super(`Run ${JSON.stringify(runId)} is held by another worker`);
    this.name = 'RunLeaseContendedError';
  }
}

/** A provider reused a call id for a different logical effect. */
export class EffectReplayMismatchError extends DurableExecutionError {
  constructor(public readonly runId: string, public readonly callId: string) {
    super(`Tool call ${JSON.stringify(callId)} of run ${JSON.stringify(runId)} changed across replay`);
    this.name = 'EffectReplayMismatchError';
  }
}

/** A round cannot be keyed unambiguously, so none of its effects may start. */
export class InvalidDurableToolCallError extends DurableExecutionError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDurableToolCallError';
  }
}

/**
 * Put every model-issued tool call behind durable intent/result recording.
 * The model's call id is the idempotency key inside one run.
 */
export class DurableToolExecutor implements ToolExecutor {
  private readonly inner: ToolExecutor;
  private readonly ledger: EffectLedger;
  private readonly runId: string;
  private fencingToken: number;
  private readonly renewLease?: () => Promise<number>;

  readonly get?: (name: string) => ToolDefinition | undefined;
  readonly withTools?: (tools: ToolDefinition[]) => ToolExecutor;
  readonly withContext?: (context: ToolContext) => ToolExecutor;
  readonly getContext?: () => ToolContext;

  constructor(options: DurableToolExecutorOptions) {
    if (!options.runId) throw new Error('DurableToolExecutor runId must not be empty');
    this.inner = options.inner;
    this.ledger = options.ledger;
    this.runId = options.runId;
    this.fencingToken = options.fencingToken;
    this.renewLease = options.renewLease;

    if (this.inner.get) this.get = this.inner.get.bind(this.inner);
    if (this.inner.getContext) this.getContext = this.inner.getContext.bind(this.inner);
    if (this.inner.withTools) {
      this.withTools = (tools) => this.rewrap(this.inner.withTools?.(tools) ?? this.inner);
    }
    if (this.inner.withContext) {
      this.withContext = (context) => this.rewrap(this.inner.withContext?.(context) ?? this.inner);
    }
  }

  list(): ToolDefinitionSummary[] {
    return this.inner.list();
  }

  async execute(
    name: string,
    callId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!callId) throw new InvalidDurableToolCallError(
      'Durable tool calls require a non-empty call id',
    );
    const fingerprint = fingerprintInput(name, input);
    const effectKey = `agent:tool:${callId}`;
    const existing = await this.ledger.read(this.runId, effectKey);
    if (existing.status === 'done') return replay(existing.value, this.runId, callId, name, fingerprint);
    if (existing.status === 'running') throw new IndeterminateEffectError(this.runId, effectKey);

    if (this.renewLease) this.fencingToken = await this.renewLease();
    const inserted = await this.ledger.start(this.runId, effectKey, this.fencingToken);
    if (!inserted) {
      const winner = await this.ledger.read(this.runId, effectKey);
      if (winner.status === 'done') {
        return replay(winner.value, this.runId, callId, name, fingerprint);
      }
      if (winner.status === 'running') throw new IndeterminateEffectError(this.runId, effectKey);
      throw new Error(`Effect ${JSON.stringify(effectKey)} disappeared while recording intent`);
    }

    // Deliberately do not clear running intent when the executor throws. A thrown
    // infrastructure/control error cannot prove the external effect did not happen.
    const result = await this.inner.execute(name, callId, input, signal);
    const stored: StoredToolEffect = {
      version: 1,
      kind: 'tool',
      name,
      inputFingerprint: fingerprint,
      result,
    };
    await this.ledger.finish(this.runId, effectKey, stored, this.fencingToken);
    return result;
  }

  async executeBatch(calls: ToolBatchCall[], signal?: AbortSignal): Promise<ToolBatchResult[]> {
    validateCallIds(calls);
    const exclusiveIndex = calls.findIndex(call => isExclusive(this.inner.get?.(call.name), call.input));
    if (exclusiveIndex >= 0) {
      const exclusive = await this.executeOne(calls[exclusiveIndex], signal);
      if (exclusive.result.type === 'suspend' || signal?.aborted) return [exclusive];
      const remaining = calls.filter((_, index) => index !== exclusiveIndex);
      const rest = await this.executeBatch(remaining, signal);
      const byId = new Map([exclusive, ...rest].map(result => [result.callId, result]));
      return calls.flatMap(call => {
        const result = byId.get(call.callId);
        return result ? [result] : [];
      });
    }

    const allConcurrencySafe = calls.every(call =>
      isConcurrencySafe(this.inner.get?.(call.name), call.input));
    if (allConcurrencySafe) return Promise.all(calls.map(call => this.executeOne(call, signal)));

    const results: ToolBatchResult[] = [];
    for (const call of calls) {
      if (signal?.aborted) break;
      const result = await this.executeOne(call, signal);
      results.push(result);
      if (result.result.type === 'suspend') break;
    }
    return results;
  }

  private async executeOne(call: ToolBatchCall, signal?: AbortSignal): Promise<ToolBatchResult> {
    const result = await this.execute(call.name, call.callId, call.input, signal) as ToolResult;
    return {
      callId: call.callId,
      name: call.name,
      result,
      isError: result.type === 'error',
    };
  }

  private rewrap(inner: ToolExecutor): DurableToolExecutor {
    return new DurableToolExecutor({
      inner,
      ledger: this.ledger,
      runId: this.runId,
      fencingToken: this.fencingToken,
      renewLease: this.renewLease,
    });
  }
}

function validateCallIds(calls: ToolBatchCall[]): void {
  const seen = new Set<string>();
  for (const [index, call] of calls.entries()) {
    if (!call.callId) {
      throw new InvalidDurableToolCallError(
        `Tool call ${index} (${JSON.stringify(call.name)}) has no id`,
      );
    }
    if (seen.has(call.callId)) {
      throw new InvalidDurableToolCallError(
        `Tool call id ${JSON.stringify(call.callId)} appears twice in one batch`,
      );
    }
    seen.add(call.callId);
  }
}

function replay(
  value: unknown,
  runId: string,
  callId: string,
  name: string,
  fingerprint: string,
): unknown {
  if (!isStoredToolEffect(value)
    || value.name !== name
    || value.inputFingerprint !== fingerprint) {
    throw new EffectReplayMismatchError(runId, callId);
  }
  return value.result;
}

function isStoredToolEffect(value: unknown): value is StoredToolEffect {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredToolEffect>;
  return record.version === 1
    && record.kind === 'tool'
    && typeof record.name === 'string'
    && typeof record.inputFingerprint === 'string'
    && 'result' in record;
}

function fingerprintInput(name: string, input: unknown): string {
  return createHash('sha256').update(stableJson([name, input])).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Tool input must be JSON-serializable');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key =>
    `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function isExclusive(tool: ToolDefinition | undefined, input: unknown): boolean {
  return resolveFlag(tool?.isExclusive, input);
}

function isConcurrencySafe(tool: ToolDefinition | undefined, input: unknown): boolean {
  return resolveFlag(tool?.isConcurrencySafe, input);
}

function resolveFlag(
  value: boolean | ((input?: unknown) => boolean) | undefined,
  input: unknown,
): boolean {
  return typeof value === 'function' ? value(input) : value === true;
}
