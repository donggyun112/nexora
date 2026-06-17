/**
 * PiAiProvider — Nexora LLMProvider implementation backed by @earendil-works/pi-ai.
 *
 * Delegates message/option/event/response conversion to the pure functions in
 * `./mapping.ts`. Supports any pi-ai provider (16+ providers, including OAuth-based
 * GitHub Copilot and OpenAI Codex).
 */

import { stream as piStream, complete as piComplete, getModel } from '@earendil-works/pi-ai';
import type { KnownProvider } from '@earendil-works/pi-ai';
import type {
  LLMProvider, LLMMessage, LLMOptions, LLMChunk, LLMResponse,
} from '@dongkseo/contracts';
import {
  toPiContext, toPiOptions, fromPiChunk, fromPiAssistantMessage,
} from './mapping.js';

export interface PiAiProviderOptions {
  /** pi-ai provider id (e.g. 'openai', 'anthropic', 'google', 'github-copilot', 'openai-codex') */
  provider: string;
  /** pi-ai model id (e.g. 'gpt-4o-mini', 'claude-sonnet-4-20250514') */
  model: string;
  /** Override env-based API key. */
  apiKey?: string;
  /** Session id for providers that support session-based prompt caching. */
  sessionId?: string;
  /** Prompt cache retention ('short' | 'long' | 'none'). */
  cacheRetention?: 'short' | 'long' | 'none';
}

export class PiAiProvider implements LLMProvider {
  private readonly model: ReturnType<typeof getModel>;
  private readonly modelId: string;
  private readonly providerName: string;
  private readonly apiKey?: string;
  private readonly sessionId?: string;
  private readonly cacheRetention?: 'short' | 'long' | 'none';
  // Cache per-call model resolutions to avoid repeated getModel calls for the same override.
  private readonly modelCache = new Map<string, ReturnType<typeof getModel>>();

  constructor(options: PiAiProviderOptions) {
    this.providerName = options.provider;
    const initial = getModel(options.provider as KnownProvider, options.model as never);
    if (!initial) {
      throw new Error(`pi-ai: unknown model "${options.model}" for provider "${options.provider}"`);
    }
    this.model = initial;
    this.modelId = options.model;
    this.apiKey = options.apiKey;
    this.sessionId = options.sessionId;
    this.cacheRetention = options.cacheRetention;
    this.modelCache.set(options.model, this.model);
  }

  private resolveModel(override?: string): { model: ReturnType<typeof getModel>; id: string } {
    if (!override || override === this.modelId) {
      return { model: this.model, id: this.modelId };
    }
    let cached = this.modelCache.get(override);
    if (!cached) {
      // pi-ai 0.75.5 getModel returns undefined for unknown ids rather than throwing.
      // Surface this as a clear error here rather than letting it fail deep in pi-ai.
      cached = getModel(this.providerName as KnownProvider, override as never);
      if (!cached) {
        throw new Error(`pi-ai: unknown model "${override}" for provider "${this.providerName}"`);
      }
      this.modelCache.set(override, cached);
    }
    return { model: cached, id: override };
  }

  private buildOpts(options?: LLMOptions): Record<string, unknown> {
    const opts: Record<string, unknown> = { ...toPiOptions(options) };
    if (this.apiKey) opts.apiKey = this.apiKey;
    if (this.sessionId) opts.sessionId = this.sessionId;
    if (this.cacheRetention) opts.cacheRetention = this.cacheRetention;
    return opts;
  }

  private buildContext(messages: LLMMessage[], options?: LLMOptions): Record<string, unknown> {
    const mapped = toPiContext(messages, options, {
      api: this.model.api as string,
      provider: this.model.provider as string,
    });
    const ctx: Record<string, unknown> = {
      systemPrompt: mapped.systemPrompt,
      messages: mapped.messages,
    };
    if (options?.tools && options.tools.length > 0) {
      ctx.tools = options.tools;
    }
    return ctx;
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    const ctx = this.buildContext(messages, options);
    const state = { toolNames: new Map<string, string>() };
    const resolved = this.resolveModel(options?.model);
    const events = piStream(resolved.model, ctx as never, this.buildOpts(options) as never);
    for await (const event of events) {
      const chunk = fromPiChunk(event, state);
      if (chunk) yield chunk;
    }
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const ctx = this.buildContext(messages, options);
    const resolved = this.resolveModel(options?.model);
    const result = await piComplete(resolved.model, ctx as never, this.buildOpts(options) as never);
    const mapped = fromPiAssistantMessage(result);
    return { ...mapped, model: resolved.id };
  }
}
