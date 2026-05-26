/**
 * Nexora AgentMiddleware[] → pi-agent-core AgentLoopConfig hooks.
 *
 * 매핑:
 *   beforeToolCall  → AgentLoopConfig.beforeToolCall (1:1)
 *   afterToolCall   → AgentLoopConfig.afterToolCall  (1:1)
 *   beforeExecution → PiAgentRunner.execute() 진입 시 manual
 *   afterExecution  → PiAgentRunner.execute() finally에서 manual
 *   onSessionStart/End → PiAgentRunner 진입/종료에서 manual
 *   beforeLLMCall   → 누락 (pi에 직접 대응 훅 없음)
 *   beforePromptBuild → transformContext로 흡수 (단, systemPrompt는 변경 불가)
 *   onCompact/onBudgetExceeded → 미구현 (Stage 3에서)
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
  throw new Error('not implemented');
}
