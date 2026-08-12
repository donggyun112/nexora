import { createHash } from 'node:crypto';
import type {
  EffectLedger,
  LLMChunk,
  LLMMessage,
  LLMOptions,
  LLMProvider,
  LLMResponse,
} from '@dongkseo/contracts';
import {
  EffectReplayMismatchError,
  IndeterminateEffectError,
} from './durable-tool-executor.js';

interface StoredModelStream {
  version: 1;
  kind: 'model-stream';
  requestFingerprint: string;
  chunks: LLMChunk[];
}

interface StoredModelCompletion {
  version: 1;
  kind: 'model-complete';
  requestFingerprint: string;
  response: LLMResponse;
}

export interface DurableLLMProviderOptions {
  inner: LLMProvider;
  ledger: EffectLedger;
  runId: string;
  fencingToken: number;
  /** Stable provider/model configuration not already present in LLMOptions. */
  modelIdentity: unknown;
  /** Renew the enclosing run lease immediately before a new request starts. */
  renewLease?: () => Promise<number>;
}

/** Persist and replay model requests through the same effect ledger as tools. */
export class DurableLLMProvider implements LLMProvider {
  private fencingToken: number;

  constructor(private readonly options: DurableLLMProviderOptions) {
    if (!options.runId) throw new Error('DurableLLMProvider runId must not be empty');
    this.fencingToken = options.fencingToken;
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    const request = requestIdentity('stream', this.options.modelIdentity, messages, options);
    const effectKey = `agent:model:${request.digest}`;
    const existing = await this.options.ledger.read(this.options.runId, effectKey);
    if (existing.status === 'done') {
      const stored = decodeStream(existing.value, this.options.runId, effectKey, request.fingerprint);
      for (const chunk of stored.chunks) yield structuredClone(chunk);
      return;
    }
    if (existing.status === 'running') {
      throw new IndeterminateEffectError(this.options.runId, effectKey);
    }

    await this.begin(effectKey);
    const chunks: LLMChunk[] = [];
    let committed = false;
    let cleared = false;
    const source = this.options.inner.stream(messages, options);
    try {
      for await (const chunk of source) {
        chunks.push(structuredClone(chunk));
        yield chunk;
      }
      const stored: StoredModelStream = {
        version: 1,
        kind: 'model-stream',
        requestFingerprint: request.fingerprint,
        chunks,
      };
      await this.options.ledger.finish(
        this.options.runId,
        effectKey,
        stored,
        this.fencingToken,
      );
      committed = true;
    } catch (error) {
      if (chunks.length === 0) {
        await this.options.ledger.forget(
          this.options.runId,
          effectKey,
          this.fencingToken,
        );
        cleared = true;
      }
      throw error;
    } finally {
      if (!committed) {
        try { await source.return(undefined as unknown as LLMChunk); } catch { /* preserve cause */ }
        if (chunks.length === 0 && !cleared) {
          await this.options.ledger.forget(
            this.options.runId,
            effectKey,
            this.fencingToken,
          );
        }
      }
    }
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const request = requestIdentity('complete', this.options.modelIdentity, messages, options);
    const effectKey = `agent:model:${request.digest}`;
    const existing = await this.options.ledger.read(this.options.runId, effectKey);
    if (existing.status === 'done') {
      const stored = decodeCompletion(
        existing.value,
        this.options.runId,
        effectKey,
        request.fingerprint,
      );
      return structuredClone(stored.response);
    }
    if (existing.status === 'running') {
      throw new IndeterminateEffectError(this.options.runId, effectKey);
    }

    await this.begin(effectKey);
    try {
      const response = await this.options.inner.complete(messages, options);
      const stored: StoredModelCompletion = {
        version: 1,
        kind: 'model-complete',
        requestFingerprint: request.fingerprint,
        response: structuredClone(response),
      };
      await this.options.ledger.finish(
        this.options.runId,
        effectKey,
        stored,
        this.fencingToken,
      );
      return response;
    } catch (error) {
      await this.options.ledger.forget(
        this.options.runId,
        effectKey,
        this.fencingToken,
      );
      throw error;
    }
  }

  private async begin(effectKey: string): Promise<void> {
    if (this.options.renewLease) this.fencingToken = await this.options.renewLease();
    const inserted = await this.options.ledger.start(
      this.options.runId,
      effectKey,
      this.fencingToken,
    );
    if (inserted) return;

    const winner = await this.options.ledger.read(this.options.runId, effectKey);
    if (winner.status === 'running') {
      throw new IndeterminateEffectError(this.options.runId, effectKey);
    }
    // A same-process race can complete between read and start. The caller will
    // retry the logical request and take the normal replay path.
    if (winner.status === 'done') {
      throw new IndeterminateEffectError(this.options.runId, effectKey);
    }
    throw new Error(`Effect ${JSON.stringify(effectKey)} disappeared while recording intent`);
  }
}

function requestIdentity(
  mode: 'stream' | 'complete',
  modelIdentity: unknown,
  messages: LLMMessage[],
  options?: LLMOptions,
): { digest: string; fingerprint: string } {
  const { signal: _signal, ...stableOptions } = options ?? {};
  const fingerprint = JSON.stringify(stableValue({
    mode,
    model: modelIdentity,
    messages,
    options: stableOptions,
  }));
  return {
    fingerprint,
    digest: createHash('sha256').update(fingerprint).digest('hex').slice(0, 32),
  };
}

function stableValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Model request contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .filter(key => object[key] !== undefined)
        .sort()
        .map(key => [key, stableValue(object[key])]),
    );
  }
  throw new Error(`Model request contains unsupported ${typeof value} value`);
}

function decodeStream(
  value: unknown,
  runId: string,
  effectKey: string,
  fingerprint: string,
): StoredModelStream {
  if (!value || typeof value !== 'object') throw mismatch(runId, effectKey);
  const stored = value as Partial<StoredModelStream>;
  if (stored.version !== 1
    || stored.kind !== 'model-stream'
    || stored.requestFingerprint !== fingerprint
    || !Array.isArray(stored.chunks)) {
    throw mismatch(runId, effectKey);
  }
  return stored as StoredModelStream;
}

function decodeCompletion(
  value: unknown,
  runId: string,
  effectKey: string,
  fingerprint: string,
): StoredModelCompletion {
  if (!value || typeof value !== 'object') throw mismatch(runId, effectKey);
  const stored = value as Partial<StoredModelCompletion>;
  if (stored.version !== 1
    || stored.kind !== 'model-complete'
    || stored.requestFingerprint !== fingerprint
    || !stored.response) {
    throw mismatch(runId, effectKey);
  }
  return stored as StoredModelCompletion;
}

function mismatch(runId: string, effectKey: string): EffectReplayMismatchError {
  return new EffectReplayMismatchError(runId, effectKey);
}
