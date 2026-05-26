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
} from '@nexora/contracts';
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
  private readonly apiKey?: string;
  private readonly sessionId?: string;
  private readonly cacheRetention?: 'short' | 'long' | 'none';

  constructor(options: PiAiProviderOptions) {
    this.model = getModel(options.provider as KnownProvider, options.model as never);
    this.modelId = options.model;
    this.apiKey = options.apiKey;
    this.sessionId = options.sessionId;
    this.cacheRetention = options.cacheRetention;
  }

  private buildOpts(options?: LLMOptions): Record<string, unknown> {
    const opts: Record<string, unknown> = { ...toPiOptions(options) };
    if (this.apiKey) opts.apiKey = this.apiKey;
    if (this.sessionId) opts.sessionId = this.sessionId;
    if (this.cacheRetention) opts.cacheRetention = this.cacheRetention;
    return opts;
  }

  private buildContext(messages: LLMMessage[], options?: LLMOptions): Record<string, unknown> {
    const mapped = toPiContext(messages, options);
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
    const events = piStream(this.model, ctx as never, this.buildOpts(options) as never);
    for await (const event of events) {
      const chunk = fromPiChunk(event, state);
      if (chunk) yield chunk;
    }
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const ctx = this.buildContext(messages, options);
    const result = await piComplete(this.model, ctx as never, this.buildOpts(options) as never);
    const mapped = fromPiAssistantMessage(result);
    return { ...mapped, model: this.modelId };
  }
}
