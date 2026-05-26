/**
 * Nexora ↔ pi-ai 메시지/옵션 변환.
 *
 * Nexora LLMMessage(role: 'system'|'user'|'assistant'|'tool_result',
 *                   content: string | LLMContentBlock[])
 *   ↔ pi-ai Context { systemPrompt?, messages: Message[], tools? }
 *
 * pi-ai Message는 UserMessage | AssistantMessage | ToolResultMessage.
 * toolResult 는 별도 메시지로 분리되며 toolCallId / toolName / isError / timestamp 필수.
 * Assistant 히스토리 replay 시 api/provider/model/usage/stopReason/timestamp 는 placeholder 로 채운다.
 */

import type {
  LLMMessage,
  LLMOptions,
  LLMChunk,
  LLMContentBlock,
  LLMResponse,
} from '@nexora/contracts';
import type {
  Message,
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ImageContent,
  ThinkingContent,
  ToolCall,
  UserMessage,
  ToolResultMessage,
} from '@earendil-works/pi-ai';

export interface MappedContext {
  systemPrompt: string | undefined;
  messages: Message[];
}

type UserContent = string | (TextContent | ImageContent)[];
type AssistantContent = (TextContent | ThinkingContent | ToolCall)[];

export function toPiContext(messages: LLMMessage[], options?: LLMOptions): MappedContext {
  let systemPrompt = options?.systemPrompt;
  const piMessages: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt = typeof msg.content === 'string'
        ? msg.content
        : extractText(msg.content);
      continue;
    }

    if (msg.role === 'user') {
      piMessages.push({
        role: 'user',
        content: toPiUserContent(msg.content),
        timestamp: Date.now(),
      } as UserMessage);
      continue;
    }

    if (msg.role === 'assistant') {
      // History replay: AssistantMessage requires api/provider/model/usage/stopReason/timestamp.
      // pi-ai stores these for round-tripping; for replayed history we provide sentinels.
      piMessages.push({
        role: 'assistant',
        content: toPiAssistantContent(msg.content),
        api: 'openai-completions',
        provider: 'openai',
        model: 'replay',
        stopReason: 'stop',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      } as AssistantMessage);
      continue;
    }

    if (msg.role === 'tool_result') {
      if (typeof msg.content === 'string') continue;
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue;
        piMessages.push({
          role: 'toolResult',
          toolCallId: block.id,
          toolName: '',
          content: [{ type: 'text', text: block.content }],
          isError: block.isError ?? false,
          timestamp: Date.now(),
        } as ToolResultMessage);
      }
    }
  }

  return { systemPrompt, messages: piMessages };
}

function toPiUserContent(content: string | LLMContentBlock[]): UserContent {
  if (typeof content === 'string') return content;
  const blocks: (TextContent | ImageContent)[] = [];
  for (const b of content) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    else if (b.type === 'image') blocks.push({ type: 'image', data: b.data, mimeType: b.mimeType });
  }
  return blocks;
}

function toPiAssistantContent(content: string | LLMContentBlock[]): AssistantContent {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const blocks: (TextContent | ThinkingContent | ToolCall)[] = [];
  for (const b of content) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_call') {
      blocks.push({
        type: 'toolCall',
        id: b.id,
        name: b.name,
        arguments: (b.arguments ?? {}) as Record<string, any>,
      });
    }
  }
  return blocks;
}

function extractText(blocks: LLMContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<LLMContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('');
}

export function toPiOptions(options: LLMOptions | undefined): {
  signal?: AbortSignal;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  maxTokens?: number;
  temperature?: number;
  tools?: { name: string; description: string; parameters: unknown }[];
} {
  throw new Error('not implemented');
}

export function fromPiChunk(
  event: AssistantMessageEvent,
  state: { toolNames: Map<string, string> },
): LLMChunk | undefined {
  throw new Error('not implemented');
}

export function fromPiAssistantMessage(msg: AssistantMessage): LLMResponse {
  throw new Error('not implemented');
}
