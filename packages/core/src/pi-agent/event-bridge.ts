/**
 * pi-agent-core AgentEvent → Nexora AgentEvent 변환.
 *
 * pi 이벤트는 Agent.subscribe(listener) 로 받는다. PiAgentRunner는
 * 변환된 Nexora 이벤트를 AsyncGenerator로 yield.
 *
 * 매핑:
 *   tool_execution_start → tool_call
 *   tool_execution_end   → tool_result (+ details에 artifact 있으면 artifact 추가)
 *   message_update       → text 또는 thinking (inner AssistantMessageEvent 확인)
 *   agent_end            → done
 */

import type { AgentEvent as NexoraEvent } from '@nexora/contracts';
import type { AgentEvent as PiEvent } from '@earendil-works/pi-agent-core';

export function* fromPiEvent(event: PiEvent): Generator<NexoraEvent> {
  throw new Error('not implemented');
}
