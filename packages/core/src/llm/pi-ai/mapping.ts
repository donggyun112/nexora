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

export function toPiContext(
  messages: LLMMessage[],
  options?: LLMOptions,
  replayShape?: { api: string; provider: string },
): MappedContext {
  let systemPrompt = options?.systemPrompt;
  const piMessages: Message[] = [];
  const toolNames = new Map<string, string>(); // toolCallId → toolName

  const replayApi = replayShape?.api ?? 'openai-completions';
  const replayProvider = replayShape?.provider ?? 'openai';

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
      // Record any tool calls so we can resolve toolName on subsequent tool_result.
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_call') {
            toolNames.set(block.id, block.name);
          }
        }
      }
      // History replay: AssistantMessage requires api/provider/model/usage/stopReason/timestamp.
      // pi-ai stores these for round-tripping; for replayed history we provide sentinels.
      piMessages.push({
        role: 'assistant',
        content: toPiAssistantContent(msg.content),
        api: replayApi,
        provider: replayProvider,
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
          toolName: toolNames.get(block.id) ?? '',
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
  reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  maxTokens?: number;
  temperature?: number;
} {
  if (!options) return {};
  const out: ReturnType<typeof toPiOptions> = {};
  if (options.signal) out.signal = options.signal;
  if (options.maxTokens !== undefined) out.maxTokens = options.maxTokens;
  if (options.temperature !== undefined) out.temperature = options.temperature;
  if (options.thinkingLevel && options.thinkingLevel !== 'off') {
    out.reasoning = options.thinkingLevel as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  }
  return out;
}

export function fromPiChunk(
  event: AssistantMessageEvent,
  state: { toolNames: Map<string, string> },
): LLMChunk | undefined {
  switch (event.type) {
    case 'text_delta':
      return { type: 'text_delta', delta: event.delta };
    case 'thinking_delta':
      return { type: 'thinking_delta', delta: event.delta };
    case 'toolcall_start': {
      const block = event.partial.content[event.contentIndex];
      if (!block || block.type !== 'toolCall') return undefined;
      state.toolNames.set(String(event.contentIndex), block.id);
      return { type: 'tool_call_start', id: block.id, name: block.name };
    }
    case 'toolcall_delta': {
      const idFromState = state.toolNames.get(String(event.contentIndex));
      const block = event.partial.content[event.contentIndex];
      const id = idFromState
        ?? (block && block.type === 'toolCall' ? block.id : '');
      return { type: 'tool_call_delta', id, delta: event.delta };
    }
    case 'done': {
      const text = event.message.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('');
      return { type: 'done', content: text, stopReason: piToStopReason(event.message.stopReason) };
    }
    case 'error': {
      const errEvent = event as unknown as { reason: 'aborted' | 'error'; error: AssistantMessage & { errorMessage?: string } };
      const message = errEvent.error.errorMessage ?? `pi-ai ${errEvent.reason}`;
      const err = new Error(message);
      if (errEvent.reason === 'aborted') err.name = 'AbortError';
      throw err;
    }
    default:
      return undefined;
  }
}

function piToStopReason(reason: string): string {
  if (reason === 'toolUse') return 'tool_use';
  if (reason === 'stop') return 'end_turn';
  if (reason === 'aborted') return 'aborted';
  return reason;
}

export function fromPiAssistantMessage(msg: AssistantMessage): LLMResponse {
  // pi-ai signals provider failures via assistantMessage with stopReason='error'/'aborted'
  // and a populated errorMessage. Surface these as Error instead of silently returning
  // an empty AssistantMessage to the caller.
  if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
    const message = (msg as unknown as { errorMessage?: string }).errorMessage ?? `pi-ai ${msg.stopReason}`;
    const err = new Error(message);
    if (msg.stopReason === 'aborted') {
      err.name = 'AbortError';
    } else {
      // Provider-side failure: the request was sent and upstream broke (overload,
      // dropped stream, SDK parse error). The provider catch dropped the original
      // status/code and kept only the message, so retry layers can't classify it
      // by status. Mark it so they can treat it as transient and retry.
      (err as { providerError?: boolean }).providerError = true;
    }
    throw err;
  }

  const textParts: string[] = [];
  const toolCalls: { id: string; name: string; arguments: unknown }[] = [];

  for (const block of msg.content) {
    if (block.type === 'text') textParts.push(block.text);
    else if (block.type === 'toolCall') {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments });
    }
  }

  const cost = (msg.usage as { cost?: { cacheRead?: number } }).cost;
  const usage = {
    promptTokens: msg.usage.input,
    completionTokens: msg.usage.output,
    cachedTokens: cost?.cacheRead ?? 0,
  };

  return {
    content: textParts.join(''),
    model: '',
    stopReason: piToStopReason(msg.stopReason),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}
