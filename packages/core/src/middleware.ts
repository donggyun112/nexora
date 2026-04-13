/**
 * Middleware Pipeline — 에이전트 실행 전후 훅 체인.
 *
 * Deep Agents의 middleware 패턴 차용.
 * 도구 호출 전후, LLM 호출 전후, 에이전트 시작/종료 시점에 훅 가능.
 */

import type {
  AgentInput,
  AgentEvent,
  ChatMessage,
  ToolDefinition,
  ToolResult,
  LLMResponse,
  LLMUsage,
} from '@nexora/contracts';

// ─── 훅 컨텍스트 ────────────────────────────────────────────────────────────

export interface BeforeExecutionContext {
  input: AgentInput;
  /** 도구 목록 (수정 가능 — 필터링/추가) */
  tools: ToolDefinition[];
  /** 시스템 프롬프트 (수정 가능) */
  systemPrompt: string;
}

export interface AfterExecutionContext {
  input: AgentInput;
  /** 발생한 모든 이벤트 */
  events: AgentEvent[];
  /** 최종 결과 메시지 */
  finalContent: string;
  /** 에러 (있을 경우) */
  error?: Error;
}

export interface BeforeToolCallContext {
  toolName: string;
  callId: string;
  input: unknown;
  tool: ToolDefinition;
}

export interface AfterToolCallContext {
  toolName: string;
  callId: string;
  input: unknown;
  result: ToolResult;
  isError: boolean;
}

export interface BeforeLLMCallContext {
  messages: ChatMessage[];
  systemPrompt: string;
}

export interface AfterLLMCallContext {
  /** The LLM response (inspect/modify content, usage, etc.) */
  response: LLMResponse;
  /** Token usage from this call */
  usage?: LLMUsage;
}

// ─── Middleware 인터페이스 ─────────────────────────────────────────────────

export interface AgentMiddleware {
  name: string;
  beforeExecution?(ctx: BeforeExecutionContext): Promise<void> | void;
  afterExecution?(ctx: AfterExecutionContext): Promise<void> | void;
  beforeToolCall?(ctx: BeforeToolCallContext): Promise<void> | void;
  afterToolCall?(ctx: AfterToolCallContext): Promise<void> | void;
  beforeLLMCall?(ctx: BeforeLLMCallContext): Promise<void> | void;
  afterLLMCall?(ctx: AfterLLMCallContext): Promise<void> | void;
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

export class MiddlewarePipeline {
  private readonly middlewares: AgentMiddleware[];

  constructor(middlewares: AgentMiddleware[] = []) {
    this.middlewares = middlewares;
  }

  add(middleware: AgentMiddleware): void {
    this.middlewares.push(middleware);
  }

  async runBeforeExecution(ctx: BeforeExecutionContext): Promise<void> {
    for (const m of this.middlewares) {
      if (m.beforeExecution) await m.beforeExecution(ctx);
    }
  }

  async runAfterExecution(ctx: AfterExecutionContext): Promise<void> {
    // 역순으로 실행 (스택 패턴)
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const m = this.middlewares[i];
      if (m.afterExecution) await m.afterExecution(ctx);
    }
  }

  async runBeforeToolCall(ctx: BeforeToolCallContext): Promise<void> {
    for (const m of this.middlewares) {
      if (m.beforeToolCall) await m.beforeToolCall(ctx);
    }
  }

  async runAfterToolCall(ctx: AfterToolCallContext): Promise<void> {
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const m = this.middlewares[i];
      if (m.afterToolCall) await m.afterToolCall(ctx);
    }
  }

  async runBeforeLLMCall(ctx: BeforeLLMCallContext): Promise<void> {
    for (const m of this.middlewares) {
      if (m.beforeLLMCall) await m.beforeLLMCall(ctx);
    }
  }

  async runAfterLLMCall(ctx: AfterLLMCallContext): Promise<void> {
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const m = this.middlewares[i];
      if (m.afterLLMCall) await m.afterLLMCall(ctx);
    }
  }

  list(): string[] {
    return this.middlewares.map(m => m.name);
  }
}

// ─── 기본 미들웨어들 ───────────────────────────────────────────────────────

/** 단순 로깅 미들웨어 */
export function loggingMiddleware(
  logger: { info: (msg: string, data?: unknown) => void },
): AgentMiddleware {
  return {
    name: 'logging',
    beforeExecution: (ctx) => {
      logger.info('agent.start', { tools: ctx.tools.length });
    },
    afterExecution: (ctx) => {
      logger.info('agent.end', {
        events: ctx.events.length,
        error: ctx.error?.message,
      });
    },
    beforeToolCall: (ctx) => {
      logger.info(`tool.call ${ctx.toolName}`, { callId: ctx.callId });
    },
    afterToolCall: (ctx) => {
      logger.info(`tool.result ${ctx.toolName}`, { isError: ctx.isError });
    },
  };
}

/** 도구 필터링 미들웨어 — 허용 목록만 통과 */
export function toolFilterMiddleware(allowedTools: string[]): AgentMiddleware {
  const allowed = new Set(allowedTools);
  return {
    name: 'tool-filter',
    beforeExecution: (ctx) => {
      ctx.tools = ctx.tools.filter(t => allowed.has(t.name));
    },
  };
}
