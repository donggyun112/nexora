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
    return Array.from(this.tools.values())
      .filter(isAvailable)
      .map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
  }

  withTools(tools: ToolDefinition[]): CoreToolExecutor {
    return new CoreToolExecutor({
      tools,
      context: this.context,
      logger: this.logger,
    });
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
    if (!isAvailable(tool)) {
      return { type: 'error', message: `Tool unavailable: ${name}` } satisfies ToolResult;
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
      const coerced = coerceToolArgs(tool.parameters, input);
      const result = await tool.execute(callId, coerced, ctx);
      this.logger?.debug(`tool.done ${name}`, { callId });
      return truncateResult(result, tool.maxResultSizeChars);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(`tool.error ${name}`, { callId, error: message });
      return { type: 'error', message } satisfies ToolResult;
    }
  }

  /**
   * 여러 도구 호출을 실행. isConcurrencySafe인 도구는 병렬, 나머지는 순차.
   * 원래 호출 순서를 보존하기 위해 chunked 방식 사용:
   * 연속된 concurrent 도구를 하나의 배치로 묶어 병렬 실행하고,
   * sequential 도구를 만나면 이전 배치를 flush 후 순차 실행.
   */
  async executeBatch(calls: BatchToolCall[], signal?: AbortSignal): Promise<BatchToolResult[]> {
    const results: BatchToolResult[] = new Array(calls.length);

    const exec = async (call: BatchToolCall): Promise<BatchToolResult> => {
      const raw = await this.execute(call.name, call.callId, call.input, signal);
      const result = raw as ToolResult;
      return { callId: call.callId, name: call.name, result, isError: result.type === 'error' };
    };

    // Build chunks: consecutive concurrent calls are grouped together
    let i = 0;
    while (i < calls.length) {
      const call = calls[i];
      const tool = this.get(call.name);

      if (tool && resolveBool(tool.isConcurrencySafe, call.input)) {
        // Collect consecutive concurrent calls into one batch
        const batchStart = i;
        while (i < calls.length) {
          const c = calls[i];
          const t = this.get(c.name);
          if (!t || !resolveBool(t.isConcurrencySafe, c.input)) break;
          i++;
        }
        // Execute batch in parallel
        const batch = calls.slice(batchStart, i);
        const settled = await Promise.allSettled(batch.map(exec));
        for (let j = 0; j < settled.length; j++) {
          const s = settled[j];
          const idx = batchStart + j;
          if (s.status === 'fulfilled') {
            results[idx] = s.value;
          } else {
            const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
            results[idx] = { callId: batch[j].callId, name: batch[j].name, result: { type: 'error' as const, message: msg }, isError: true };
          }
        }
      } else {
        // Sequential: execute one at a time
        try {
          results[i] = await exec(call);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results[i] = { callId: call.callId, name: call.name, result: { type: 'error' as const, message: msg }, isError: true };
        }
        i++;
      }
    }

    return results;
  }

  /** 도구 존재 여부 */
  has(name: string): boolean {
    return Boolean(this.get(name));
  }

  /** 도구 가져오기 */
  get(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);
    if (!tool || !isAvailable(tool)) return undefined;
    return tool;
  }
}

// ─── Tool argument type coercion (hermes coerce_tool_args pattern) ──────

/** Resolve a boolean | ((input?) => boolean) field. Default: false (fail-closed). */
function resolveBool(
  field: boolean | ((input?: unknown) => boolean) | undefined,
  input?: unknown,
): boolean {
  if (field === undefined) return false;
  return typeof field === 'function' ? field(input) : field;
}

function isAvailable(tool: ToolDefinition): boolean {
  try {
    return !tool.checkAvailability || tool.checkAvailability();
  } catch {
    return false;
  }
}

/**
 * LLMs frequently return wrong JSON types — "42" instead of 42,
 * "true" instead of true. Compare each arg against the tool's JSON Schema
 * and coerce when safe.
 */
export function coerceToolArgs(
  schema: Record<string, unknown>,
  input: unknown,
): unknown {
  if (!input || typeof input !== 'object') return input;
  const properties = (schema as { properties?: Record<string, { type?: string }> }).properties;
  if (!properties) return input;

  const coerced = { ...(input as Record<string, unknown>) };
  for (const [key, value] of Object.entries(coerced)) {
    if (typeof value !== 'string') continue;
    const expected = properties[key]?.type;
    if (!expected) continue;

    if (expected === 'number' || expected === 'integer') {
      const n = Number(value);
      if (!Number.isNaN(n)) coerced[key] = n;
    } else if (expected === 'boolean') {
      if (value === 'true') coerced[key] = true;
      else if (value === 'false') coerced[key] = false;
    } else if (expected === 'array') {
      try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) coerced[key] = parsed; } catch { /* keep string */ }
    }
  }
  return coerced;
}

/** Truncate a tool result if it exceeds maxResultSizeChars. */
function truncateResult(result: ToolResult, maxChars?: number): ToolResult {
  if (!maxChars || result.type !== 'text' || result.text.length <= maxChars) return result;
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.floor(maxChars * 0.2);
  const omitted = result.text.length - head - tail;
  return {
    type: 'text',
    text: result.text.slice(0, head) + `\n…[truncated ${omitted} chars]…\n` + result.text.slice(-tail),
  };
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
    case 'suspend':
      // Suspend result should be handled at the ReAct loop level, not formatted for LLM.
      // This case handles the unexpected occurrence in user code.
      return `[SUSPENDED: pending=${result.pendingId}]`;
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
