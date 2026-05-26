/**
 * pi-agent-core AgentEvent → Nexora AgentEvent 변환.
 *
 * pi 이벤트는 Agent.subscribe(listener)로 받는다. PiAgentRunner는
 * 변환된 Nexora 이벤트를 AsyncGenerator로 yield.
 *
 * 매핑:
 *   tool_execution_start → tool_call
 *   tool_execution_end   → tool_result (+ details에 artifact 있으면 추가 artifact 이벤트)
 *   message_update       → text 또는 thinking (inner assistantMessageEvent 확인)
 *   agent_end            → done (마지막 assistant content text 합쳐서)
 */

import type { AgentEvent as NexoraEvent } from '@nexora/contracts';
import type { AgentEvent as PiEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';

export function* fromPiEvent(event: PiEvent): Generator<NexoraEvent> {
  switch (event.type) {
    case 'tool_execution_start':
      yield {
        type: 'tool_call',
        id: event.toolCallId,
        name: event.toolName,
        input: event.args,
      };
      return;

    case 'tool_execution_end': {
      yield {
        type: 'tool_result',
        id: event.toolCallId,
        name: event.toolName,
        result: event.result,
        isError: event.isError,
      };
      const details = (event.result as { details?: { artifact?: unknown } } | null)?.details;
      if (details && typeof details === 'object' && 'artifact' in details) {
        yield {
          type: 'artifact',
          artifact: (details as { artifact: never }).artifact,
        };
      }
      return;
    }

    case 'message_update': {
      const inner = event.assistantMessageEvent;
      if (inner.type === 'text_delta') {
        yield { type: 'text', text: inner.delta };
      } else if (inner.type === 'thinking_delta') {
        yield { type: 'thinking', content: inner.delta };
      }
      return;
    }

    case 'agent_end': {
      const last = [...event.messages].reverse().find(
        (m): m is AssistantMessage => m.role === 'assistant',
      );
      const text = last
        ? last.content
            .filter(c => c.type === 'text')
            .map(c => (c as { text: string }).text)
            .join('')
        : '';
      yield { type: 'done', content: text, toolCalls: [] };
      return;
    }

    default:
      return;
  }
}
