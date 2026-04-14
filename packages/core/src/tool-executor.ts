/**
 * ToolExecutor — 병렬 도구 실행 + 결과 포맷팅.
 *
 * Promise.allSettled로 병렬 실행하여 한 도구가 실패해도 나머지 결과를 살림.
 * 참고: StreamingToolExecutor 패턴.
 */

import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolExecutor,
  ToolDefinitionSummary,
  AgentLogger,
} from '@nexora/contracts';

export interface ToolExecutorOptions {
  /** 등록할 도구 목록 */
  tools: ToolDefinition[];
  /** 도구에 주입할 컨텍스트 */
  context: ToolContext;
  /** 로거 (선택) */
  logger?: AgentLogger;
}

export interface BatchToolCall {
  callId: string;
  name: string;
  input: unknown;
}

export interface BatchToolResult {
  callId: string;
  name: string;
  result: ToolResult;
  isError: boolean;
}

export class CoreToolExecutor implements ToolExecutor {
  private readonly tools: Map<string, ToolDefinition>;
  private readonly context: ToolContext;
  private readonly logger?: AgentLogger;

  constructor(options: ToolExecutorOptions) {
    this.tools = new Map(options.tools.map(t => [t.name, t]));
    this.context = options.context;
    this.logger = options.logger;
  }

  list(): ToolDefinitionSummary[] {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * 단일 도구 실행 (ToolExecutor 인터페이스).
   * 결과는 unknown 반환 — 호출자가 해석.
   * signal이 주어지면 ToolContext에 합쳐서 도구로 전달.
   */
  async execute(name: string, callId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { type: 'error', message: `Unknown tool: ${name}` } satisfies ToolResult;
    }

    if (signal?.aborted || this.context.signal?.aborted) {
      return { type: 'error', message: 'aborted' } satisfies ToolResult;
    }

    // Merge call-time signal with any signal already in this.context.
    // Both must trigger cancellation.
    const ctx: ToolContext = signal
      ? { ...this.context, signal: combineSignals(this.context.signal, signal) }
      : this.context;

    try {
      this.logger?.debug(`tool.start ${name}`, { callId, input });
      const result = await tool.execute(callId, input, ctx);
      this.logger?.debug(`tool.done ${name}`, { callId });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(`tool.error ${name}`, { callId, error: message });
      return { type: 'error', message } satisfies ToolResult;
    }
  }

  /**
   * 여러 도구 호출을 병렬로 실행.
   * 한 도구가 실패해도 나머지 결과를 모두 반환.
   */
  async executeBatch(calls: BatchToolCall[], signal?: AbortSignal): Promise<BatchToolResult[]> {
    const results = await Promise.allSettled(
      calls.map(async (call) => {
        const raw = await this.execute(call.name, call.callId, call.input, signal);
        const result = raw as ToolResult;
        return {
          callId: call.callId,
          name: call.name,
          result,
          isError: result.type === 'error',
        } satisfies BatchToolResult;
      }),
    );

    return results.map((settled, idx) => {
      if (settled.status === 'fulfilled') return settled.value;
      const call = calls[idx];
      const message = settled.reason instanceof Error
        ? settled.reason.message
        : String(settled.reason);
      return {
        callId: call.callId,
        name: call.name,
        result: { type: 'error' as const, message },
        isError: true,
      } satisfies BatchToolResult;
    });
  }

  /** 도구 존재 여부 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 도구 가져오기 */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }
}

/** 도구 결과를 LLM에 전달할 텍스트로 포맷 */
export function formatToolResult(result: ToolResult): string {
  switch (result.type) {
    case 'text':
      return result.text;
    case 'image':
      return `[image: ${result.mimeType}]`;
    case 'error':
      return `[ERROR] ${result.message}`;
  }
}

/**
 * Combine two AbortSignals — the result aborts when either parent aborts.
 * Polyfill for AbortSignal.any() (Node 20+).
 */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (typeof (AbortSignal as { any?: unknown }).any === 'function') {
    return (AbortSignal as { any: (signals: AbortSignal[]) => AbortSignal }).any([a, b]);
  }
  // Manual fallback
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  else {
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}
