/**
 * PiAgentRunner — AgentRuntime 구현, pi-agent-core Agent 클래스 기반.
 *
 * Stage 1의 PiAiProvider 와는 별개 경로: PiAgentRunner는 LLMProvider 대신
 * pi-ai 의 Model<Api>를 직접 받아 Agent 내부 streamFn 으로 위임한다.
 */

import type {
  AgentRuntime, AgentInput, AgentEvent,
  ToolDefinition, ToolExecutor, MemoryProvider, AgentLogger,
} from '@nexora/contracts';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { AgentMiddleware } from '../middleware.js';

export interface PiAgentRunnerOptions {
  model: Model<Api>;
  tools: ToolDefinition[];
  toolExecutor: ToolExecutor;
  systemPrompt: string;
  middlewares?: AgentMiddleware[];
  memory?: MemoryProvider;
  logger?: AgentLogger;
  idleTimeoutMs?: number;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
}

export class PiAgentRunner implements AgentRuntime {
  constructor(_options: PiAgentRunnerOptions) {
    throw new Error('not implemented');
  }

  execute(_input: AgentInput): AsyncGenerator<AgentEvent> {
    throw new Error('not implemented');
  }

  abort(): void {
    throw new Error('not implemented');
  }
}
