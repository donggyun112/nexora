/**
 * Nexora AgentMiddleware[] → pi-agent-core AgentLoopConfig hooks.
 *
 * 매핑:
 *   beforeToolCall / afterToolCall — 1:1 to pi hooks
 *   beforeExecution / onSessionStart — manual at execute() entry
 *   afterExecution / onSessionEnd — manual at execute() finally
 *   beforeLLMCall / afterLLMCall / beforePromptBuild / onCompact / onBudgetExceeded — dropped
 *
 * 실행 순서: 일반 미들웨어 후크는 등록 순. after* 후크는 역순 (스택 패턴).
 */

import type { AgentInput, AgentEvent } from '@nexora/contracts';
import type { AgentMiddleware } from '../middleware.js';
import type { AgentLoopConfig } from '@earendil-works/pi-agent-core';

export interface BridgedConfig {
  hooks: Pick<AgentLoopConfig,
    'beforeToolCall' | 'afterToolCall' | 'transformContext' | 'shouldStopAfterTurn'>;
  runBeforeExecution: (input: AgentInput) => Promise<void>;
  runAfterExecution: (
    input: AgentInput,
    events: AgentEvent[],
    finalContent: string,
    error?: Error,
  ) => Promise<void>;
}

export function middlewaresToAgentLoopConfig(
  middlewares: AgentMiddleware[],
): BridgedConfig {
  const hasBeforeToolCall = middlewares.some(m => m.beforeToolCall);
  const hasAfterToolCall = middlewares.some(m => m.afterToolCall);

  const hooks: BridgedConfig['hooks'] = {};

  if (hasBeforeToolCall) {
    hooks.beforeToolCall = async (ctx) => {
      for (const m of middlewares) {
        if (m.beforeToolCall) {
          await m.beforeToolCall({
            toolName: ctx.toolCall.name,
            callId: ctx.toolCall.id,
            input: ctx.args,
            tool: undefined as never,
          });
        }
      }
      return undefined;
    };
  }

  if (hasAfterToolCall) {
    hooks.afterToolCall = async (ctx) => {
      for (let i = middlewares.length - 1; i >= 0; i--) {
        const m = middlewares[i];
        if (m.afterToolCall) {
          const firstText = ctx.result.content.find(c => c.type === 'text');
          await m.afterToolCall({
            toolName: ctx.toolCall.name,
            callId: ctx.toolCall.id,
            input: ctx.args,
            result: firstText
              ? { type: 'text', text: (firstText as { text: string }).text }
              : { type: 'text', text: '' },
            isError: ctx.isError,
          });
        }
      }
      return undefined;
    };
  }

  return {
    hooks,
    async runBeforeExecution(input) {
      for (const m of middlewares) {
        if (m.beforeExecution) {
          await m.beforeExecution({ input, tools: [], systemPrompt: '' });
        }
      }
      for (const m of middlewares) {
        if (m.onSessionStart) {
          await m.onSessionStart({ sessionId: (input as { requesterId?: string }).requesterId ?? 'session' });
        }
      }
    },
    async runAfterExecution(input, events, finalContent, error) {
      for (let i = middlewares.length - 1; i >= 0; i--) {
        const m = middlewares[i];
        if (m.afterExecution) {
          await m.afterExecution({ input, events, finalContent, error });
        }
      }
      for (let i = middlewares.length - 1; i >= 0; i--) {
        const m = middlewares[i];
        if (m.onSessionEnd) {
          await m.onSessionEnd({ sessionId: (input as { requesterId?: string }).requesterId ?? 'session' });
        }
      }
    },
  };
}
