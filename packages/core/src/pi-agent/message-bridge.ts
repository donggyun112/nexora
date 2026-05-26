/**
 * Nexora ChatMessage/AgentInput ↔ pi-agent-core AgentMessage 변환.
 *
 * pi-agent-core의 AgentMessage = pi-ai의 Message + 앱이 declaration merging으로
 * 추가한 custom 메시지. Nexora는 custom 타입을 추가하지 않으므로
 * AgentMessage = pi-ai Message로 취급한다.
 */

import type { AgentInput } from '@nexora/contracts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';

export interface AgentMessageBuildOptions {
  api?: string;
  provider?: string;
}

export function toAgentMessages(
  input: AgentInput,
  options?: AgentMessageBuildOptions,
): AgentMessage[] {
  throw new Error('not implemented');
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
  throw new Error('not implemented');
}
