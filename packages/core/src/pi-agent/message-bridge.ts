/**
 * Nexora ChatMessage/AgentInput ↔ pi-agent-core AgentMessage 변환.
 *
 * pi-agent-core의 AgentMessage = pi-ai의 Message + 앱이 declaration merging으로
 * 추가한 custom 메시지. Nexora는 custom 타입을 추가하지 않으므로
 * AgentMessage = pi-ai Message로 취급한다.
 */

import type { AgentInput } from '@nexora/contracts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message, UserMessage, AssistantMessage } from '@earendil-works/pi-ai';

export interface AgentMessageBuildOptions {
  api?: string;
  provider?: string;
}

const REPLAY_API = 'openai-completions';
const REPLAY_PROVIDER = 'openai';

export function toAgentMessages(
  input: AgentInput,
  options?: AgentMessageBuildOptions,
): AgentMessage[] {
  const api = options?.api ?? REPLAY_API;
  const provider = options?.provider ?? REPLAY_PROVIDER;
  const out: AgentMessage[] = [];

  for (const h of input.history ?? []) {
    if (h.role === 'user') {
      out.push({
        role: 'user',
        content: h.content,
        timestamp: Date.now(),
      } as UserMessage);
    } else if (h.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: h.content ? [{ type: 'text', text: h.content }] : [],
        api,
        provider,
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
    }
  }

  const userContent = input.images && input.images.length > 0
    ? [
        { type: 'text' as const, text: input.prompt },
        ...input.images.map(i => ({
          type: 'image' as const,
          data: i.data,
          mimeType: i.mimeType,
        })),
      ]
    : input.prompt;

  out.push({
    role: 'user',
    content: userContent,
    timestamp: Date.now(),
  } as UserMessage);

  return out;
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages as Message[];
}
