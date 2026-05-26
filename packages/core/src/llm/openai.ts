/**
 * OpenAIProvider — unified LLM provider via OpenAI-compatible API.
 *
 * Works with any provider that exposes an OpenAI-compatible chat completions
 * endpoint. Just change baseURL:
 *
 *   OpenAI direct:     baseURL = "https://api.openai.com/v1" (default)
 *   OpenRouter:        baseURL = "https://openrouter.ai/api/v1"
 *   Anthropic (proxy): baseURL = "https://openrouter.ai/api/v1", model = "anthropic/claude-..."
 *   Local (vLLM):      baseURL = "http://localhost:8000/v1"
 *   Local (Ollama):    baseURL = "http://localhost:11434/v1"
 *
 * For Anthropic-specific features (thinking, prompt cache), use AnthropicProvider instead.
 */

import OpenAI from 'openai';
import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMResponse,
  LLMContentBlock,
} from '@nexora/contracts';

export interface OpenAIProviderOptions {
  apiKey?: string;
  defaultModel?: string;
  baseURL?: string;
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
}

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_MAX_TOKENS = 4096;

/** @deprecated Stage-2 진입 시 제거 예정. 신규 코드는 `PiAiProvider`를 사용한다. */
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly defaultModel: string;
  private readonly tools?: OpenAI.Chat.Completions.ChatCompletionTool[];

  constructor(options: OpenAIProviderOptions = {}) {
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.tools = options.tools?.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    const openaiMessages = this.toOpenAIMessages(messages, options);

    const stream = await this.client.chat.completions.create(
      {
        model: options?.model ?? this.defaultModel,
        max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options?.temperature,
        messages: openaiMessages,
        tools: this.tools,
        stream: true,
      },
      options?.signal ? { signal: options.signal } : undefined,
    );

    let accumulatedText = '';
    let stopReason = 'stop';
    const toolCallBuilders = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      if (delta.content) {
        accumulatedText += delta.content;
        yield { type: 'text_delta', delta: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          let builder = toolCallBuilders.get(idx);
          if (!builder) {
            builder = { id: tc.id ?? '', name: '', arguments: '' };
            toolCallBuilders.set(idx, builder);
          }
          if (tc.id) builder.id = tc.id;
          if (tc.function?.name) {
            builder.name = tc.function.name;
            yield { type: 'tool_call_start', id: builder.id, name: builder.name };
          }
          if (tc.function?.arguments) {
            builder.arguments += tc.function.arguments;
            yield { type: 'tool_call_delta', id: builder.id, delta: tc.function.arguments };
          }
        }
      }

      if (choice.finish_reason) {
        stopReason = choice.finish_reason;
      }
    }

    yield {
      type: 'done',
      content: accumulatedText,
      stopReason,
    };
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const openaiMessages = this.toOpenAIMessages(messages, options);

    const response = await this.client.chat.completions.create(
      {
        model: options?.model ?? this.defaultModel,
        max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options?.temperature,
        messages: openaiMessages,
        tools: this.tools,
      },
      options?.signal ? { signal: options.signal } : undefined,
    );

    const choice = response.choices[0];
    if (!choice) throw new Error('OpenAI returned no choices');

    const toolCalls = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeJsonParse(tc.function.arguments),
    }));

    return {
      content: choice.message.content ?? '',
      model: response.model,
      stopReason: choice.finish_reason ?? 'stop',
      toolCalls,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
      } : undefined,
    };
  }

  private toOpenAIMessages(
    messages: LLMMessage[],
    options?: LLMOptions,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (options?.systemPrompt) {
      result.push({ role: 'system', content: options.systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        result.push({
          role: 'system',
          content: typeof msg.content === 'string' ? msg.content : extractText(msg.content),
        });
      } else if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content });
        } else {
          result.push({
            role: 'user',
            content: msg.content
              .filter((b): b is Extract<LLMContentBlock, { type: 'text' | 'image' }> =>
                b.type === 'text' || b.type === 'image')
              .map(b => {
                if (b.type === 'text') return { type: 'text' as const, text: b.text };
                return {
                  type: 'image_url' as const,
                  image_url: { url: `data:${b.mimeType};base64,${b.data}` },
                };
              }),
          });
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'assistant', content: msg.content });
        } else {
          const textBlocks = msg.content
            .filter((b): b is Extract<LLMContentBlock, { type: 'text' }> => b.type === 'text');
          const toolCalls = msg.content
            .filter((b): b is Extract<LLMContentBlock, { type: 'tool_call' }> => b.type === 'tool_call');

          const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
            role: 'assistant',
            content: textBlocks.map(b => b.text).join('') || null,
          };

          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === 'string'
                  ? tc.arguments
                  : JSON.stringify(tc.arguments),
              },
            }));
          }

          result.push(assistantMsg);
        }
      } else if (msg.role === 'tool_result') {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              result.push({
                role: 'tool',
                tool_call_id: block.id,
                content: block.content,
              });
            }
          }
        }
      }
    }

    return result;
  }
}

function extractText(blocks: LLMContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<LLMContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('');
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ─── Provider presets (hermes base_url pattern) ─────────────────────────

export interface ProviderPreset {
  baseURL: string;
  defaultModel: string;
  defaultHeaders?: Record<string, string>;
}

export const PROVIDER_PRESETS: Readonly<Record<string, ProviderPreset>> = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4',
    defaultHeaders: { 'HTTP-Referer': 'https://nexora.dev' },
  },
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
  },
  vllm: {
    baseURL: 'http://localhost:8000/v1',
    defaultModel: 'default',
  },
  lmstudio: {
    baseURL: 'http://localhost:1234/v1',
    defaultModel: 'default',
  },
};

/**
 * Create an OpenAIProvider from a preset name.
 *
 * Usage:
 *   createProvider('openai', { apiKey: 'sk-...' })
 *   createProvider('openrouter', { apiKey: 'or-...', model: 'anthropic/claude-sonnet-4' })
 *   createProvider('ollama', { model: 'llama3' })
 *   createProvider('vllm')
 */
export function createProvider(
  preset: keyof typeof PROVIDER_PRESETS | string,
  options: { apiKey?: string; model?: string; tools?: OpenAIProviderOptions['tools'] } = {},
): OpenAIProvider {
  const p = PROVIDER_PRESETS[preset];
  if (!p) {
    // Treat as custom baseURL
    return new OpenAIProvider({
      apiKey: options.apiKey ?? 'no-key',
      baseURL: preset,
      defaultModel: options.model ?? 'default',
      tools: options.tools,
    });
  }
  return new OpenAIProvider({
    apiKey: options.apiKey ?? (preset === 'ollama' || preset === 'vllm' || preset === 'lmstudio' ? 'no-key' : undefined),
    baseURL: p.baseURL,
    defaultModel: options.model ?? p.defaultModel,
    tools: options.tools,
  });
}
