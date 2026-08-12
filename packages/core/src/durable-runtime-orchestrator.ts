import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentInput,
  EffectLedger,
  PendingRuntimeInput,
  RuntimeInputQueue,
  RuntimeOrchestrationSession,
  RuntimeOrchestrator,
  RuntimeOrchestratorContext,
} from '@dongkseo/contracts';
import { OrchestrationControlError } from '@dongkseo/contracts';
import { DurableInputController } from './durable-input-controller.js';
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
  /**
   * Optional durable ordered ingress queue. Omit to keep architecture-owned direct input.
   * It must share the ledger's run-lease and fencing-token domain.
   */
  inputQueue?: RuntimeInputQueue;
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

    const inputController = this.options.inputQueue
      ? new DurableInputController({
          queue: this.options.inputQueue,
          runId,
          fencingToken,
          renewLease,
        })
      : undefined;
    if (inputController && !context.input.resumeContext) {
      const originId = context.input.inputId ?? deterministicPromptId(context.input);
      try {
        await inputController.submit(originId, {
          kind: 'user_prompt',
          originId,
          input: structuredClone(context.input),
        } satisfies PendingRuntimeInput);
      } catch (error) {
        try { await this.options.ledger.release(runId, owner); } catch { /* preserve cause */ }
        throw error;
      }
    }

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
      ...(inputController ? {
        inputs: {
          submit: async (input: PendingRuntimeInput): Promise<PendingRuntimeInput> => {
            const normalized = normalizeInput(input);
            await inputController.submit(normalized.originId!, normalized);
            return normalized;
          },
          claim: async (representedIds?: ReadonlySet<string>): Promise<PendingRuntimeInput[]> => {
            const records = await inputController.claim(representedIds);
            return records.map(record => decodeInput(record.value, record.inputId));
          },
          admit: async (inputs: readonly PendingRuntimeInput[]): Promise<void> => {
            await inputController.admit(inputIds(inputs));
          },
          discard: async (inputs: readonly PendingRuntimeInput[]): Promise<void> => {
            await inputController.discard(inputIds(inputs));
          },
        },
      } : {}),
      close: async () => {
        await this.options.ledger.release(runId, owner);
      },
    };
  }
}

function deterministicPromptId(input: AgentInput): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 24);
  return `prompt:${digest}`;
}

function normalizeInput(input: PendingRuntimeInput): PendingRuntimeInput {
  const originId = input.originId ?? randomUUID();
  if ('input' in input) {
    return { ...input, originId, input: structuredClone(input.input) };
  }
  return {
    ...input,
    originId,
    message: { ...structuredClone(input.message), id: originId },
  };
}

function decodeInput(value: unknown, inputId: string): PendingRuntimeInput {
  if (!value || typeof value !== 'object') {
    throw new OrchestrationControlError(
      `Durable input ${JSON.stringify(inputId)} has invalid payload`,
    );
  }
  const input = value as Partial<PendingRuntimeInput>;
  if (input.kind === 'user_prompt' && 'input' in input && input.input) {
    return { kind: 'user_prompt', originId: inputId, input: structuredClone(input.input) };
  }
  if (typeof input.kind === 'string' && 'message' in input && input.message) {
    return {
      kind: input.kind,
      originId: inputId,
      message: { ...structuredClone(input.message), id: inputId },
    };
  }
  throw new OrchestrationControlError(
    `Durable input ${JSON.stringify(inputId)} has invalid payload`,
  );
}

function inputIds(inputs: readonly PendingRuntimeInput[]): string[] {
  return inputs.flatMap(input => input.originId ? [input.originId] : []);
}
