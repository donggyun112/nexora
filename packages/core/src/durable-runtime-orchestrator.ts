import { randomUUID } from 'node:crypto';
import type {
  AgentInput,
  EffectLedger,
  RuntimeOrchestrationSession,
  RuntimeOrchestrator,
  RuntimeOrchestratorContext,
} from '@dongkseo/contracts';
import { DurableLLMProvider } from './durable-llm-provider.js';
import {
  DurableToolExecutor,
  RunLeaseContendedError,
} from './durable-tool-executor.js';

export interface DurableExecutionOptions {
  /** Durable store for effect intent and results. */
  ledger: EffectLedger;
  /** Stable id for this execution attempt. Tool and model effects are scoped underneath it. */
  runId: string | ((input: AgentInput) => string);
  /** Unique worker identity. Defaults to a fresh UUID for every open() call. */
  owner?: (input: AgentInput) => string;
  /** Lease lifetime. Effect boundaries renew it before every new effect. */
  leaseTtlMs?: number;
  /** Stable provider/model configuration used in the model request fingerprint. */
  modelIdentity?: unknown;
}

/** Durable ledger/lease implementation of the detachable runtime orchestration port. */
export class DurableRuntimeOrchestrator implements RuntimeOrchestrator {
  constructor(private readonly options: DurableExecutionOptions) {}

  async open(context: RuntimeOrchestratorContext): Promise<RuntimeOrchestrationSession> {
    const runId = typeof this.options.runId === 'function'
      ? this.options.runId(context.input)
      : this.options.runId;
    if (!runId) throw new Error('Durable execution runId must not be empty');

    const owner = this.options.owner?.(context.input) ?? randomUUID();
    const ttlMs = this.options.leaseTtlMs ?? 60_000;
    let fencingToken = await this.options.ledger.acquire(runId, owner, ttlMs);
    if (fencingToken === 0) throw new RunLeaseContendedError(runId);

    const renewLease = async (): Promise<number> => {
      const token = await this.options.ledger.acquire(runId, owner, ttlMs);
      if (token === 0) throw new RunLeaseContendedError(runId);
      fencingToken = token;
      return token;
    };

    return {
      wrapLLM: inner => new DurableLLMProvider({
        inner,
        ledger: this.options.ledger,
        runId,
        fencingToken,
        modelIdentity: this.options.modelIdentity ?? context.modelIdentity ?? {
          providerClass: inner.constructor.name,
        },
        renewLease,
      }),
      wrapTools: inner => new DurableToolExecutor({
        inner,
        ledger: this.options.ledger,
        runId,
        fencingToken,
        renewLease,
      }),
      close: async () => {
        await this.options.ledger.release(runId, owner);
      },
    };
  }
}
