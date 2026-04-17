/**
 * AnthropicProvider — Anthropic Messages API 래핑.
 *
 * LLMProvider 인터페이스 구현. 스트리밍 + 도구 호출 지원.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMResponse,
  LLMContentBlock,
} from '@nexora/contracts';

export interface AnthropicProviderOptions {
  /** API key (없으면 ANTHROPIC_API_KEY env 사용) */
  apiKey?: string;
  /** OAuth access token (없으면 ANTHROPIC_AUTH_TOKEN env 사용). apiKey보다 우선. */
  authToken?: string;
  /** 기본 모델 */
  defaultModel?: string;
  /** 도구 정의 (tool calling 활성화) */
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
}

const DEFAULT_MODEL: string = 'claude-sonnet-4-5';
const DEFAULT_MAX_TOKENS = 8192;

function readEnvKey(key: string): string | undefined {
  return typeof process !== 'undefined' ? process.env[key] : undefined;
}

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly defaultModel: string;
  private readonly tools?: AnthropicProviderOptions['tools'];

  constructor(options: AnthropicProviderOptions = {}) {
    const isOAuth = !!options.authToken || !!readEnvKey('ANTHROPIC_AUTH_TOKEN');
    this.client = new Anthropic({
      apiKey: isOAuth ? null : options.apiKey,
      authToken: options.authToken,
      ...(isOAuth ? {
        defaultHeaders: {
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        },
      } : {}),
    });
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.tools = options.tools;
  }

  async *stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk> {
    const { system, anthropicMessages } = this.toAnthropicMessages(messages, options);

    const stream = this.client.messages.stream(
      {
        model: options?.model ?? this.defaultModel,
        max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options?.temperature,
        system,
        messages: anthropicMessages,
        tools: this.tools as Anthropic.Tool[] | undefined,
        ...(options?.thinkingLevel && options.thinkingLevel !== 'off'
          ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget(options.thinkingLevel) } }
          : {}),
      },
      options?.signal ? { signal: options.signal } : undefined,
    );

    let accumulatedText = '';
    const toolCallNames = new Map<string, string>();

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          toolCallNames.set(block.id, block.name);
          yield { type: 'tool_call_start', id: block.id, name: block.name };
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          accumulatedText += delta.text;
          yield { type: 'text_delta', delta: delta.text };
        } else if (delta.type === 'thinking_delta') {
          yield { type: 'thinking_delta', delta: delta.thinking };
        } else if (delta.type === 'input_json_delta') {
          // tool call argument streaming — id is on the parent content_block_start
          // We need to track which block index maps to which id
          yield { type: 'tool_call_delta', id: '', delta: delta.partial_json };
        }
      }
    }

    const final = await stream.finalMessage();
    yield {
      type: 'done',
      content: accumulatedText,
      stopReason: final.stop_reason ?? 'end_turn',
    };
  }

  async complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const { system, anthropicMessages } = this.toAnthropicMessages(messages, options);

    const response = await this.client.messages.create(
      {
        model: options?.model ?? this.defaultModel,
        max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options?.temperature,
        system,
        messages: anthropicMessages,
        tools: this.tools as Anthropic.Tool[] | undefined,
      },
      options?.signal ? { signal: options.signal } : undefined,
    );

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    return {
      content: textBlocks.map(b => b.text).join(''),
      model: response.model,
      stopReason: response.stop_reason ?? 'end_turn',
      toolCalls: toolUses.map(t => ({
        id: t.id,
        name: t.name,
        arguments: t.input,
      })),
      usage: {
        promptTokens: response.usage.input_tokens
          + ((response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0)
          + ((response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0),
        completionTokens: response.usage.output_tokens,
        cachedTokens: (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
      },
    };
  }

  /**
   * Nexora LLMMessage → Anthropic MessageParam 변환.
   * system 메시지는 system 파라미터로 분리.
   */
  private toAnthropicMessages(
    messages: LLMMessage[],
    options?: LLMOptions,
  ): { system: string | undefined; anthropicMessages: Anthropic.MessageParam[] } {
    let system = options?.systemPrompt;
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = typeof msg.content === 'string'
          ? msg.content
          : extractText(msg.content);
        continue;
      }

      if (msg.role === 'user' || msg.role === 'tool_result') {
        anthropicMessages.push({
          role: 'user',
          content: this.toAnthropicContent(msg.content, msg.role),
        });
      } else if (msg.role === 'assistant') {
        anthropicMessages.push({
          role: 'assistant',
          content: this.toAnthropicContent(msg.content, msg.role),
        });
      }
    }

    return { system, anthropicMessages };
  }

  private toAnthropicContent(
    content: string | LLMContentBlock[],
    role: LLMMessage['role'],
  ): string | Anthropic.ContentBlockParam[] {
    if (typeof content === 'string') return content;

    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const block of content) {
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: block.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: block.data,
          },
        });
      } else if (block.type === 'tool_call' && role === 'assistant') {
        blocks.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.arguments as Record<string, unknown>,
        });
      } else if (block.type === 'tool_result') {
        blocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: block.content,
          is_error: block.isError,
        });
      }
    }
    return blocks;
  }
}

function thinkingBudget(level: NonNullable<LLMOptions['thinkingLevel']>): number {
  switch (level) {
    case 'minimal': return 1024;
    case 'low': return 2048;
    case 'medium': return 8192;
    case 'high': return 16384;
    default: return 0;
  }
}

function extractText(blocks: LLMContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<LLMContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('');
}
