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
  LLMResponse,
} from '@nexora/contracts';
import type {
  Message,
  AssistantMessage,
  AssistantMessageEvent,
} from '@earendil-works/pi-ai';

export interface MappedContext {
  systemPrompt: string | undefined;
  messages: Message[];
}

export function toPiContext(messages: LLMMessage[], options?: LLMOptions): MappedContext {
  throw new Error('not implemented');
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
