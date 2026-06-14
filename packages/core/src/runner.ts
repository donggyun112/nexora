/**
 * AgentRunner — AgentRuntime 구현.
 *
 * Architecture.loop()를 위임 실행하면서 미들웨어/컴팩션/idle timeout을 관리.
 * 이벤트는 AsyncGenerator로 스트리밍.
 *
 * 참고: reference runner.ts streamAgent() (단순화 + 일반화)
 */

import type {
  AgentRuntime,
  AgentInput,
  AgentEvent,
  AgentArchitecture,
  RuntimeServices,
  LLMProvider,
  MemoryProvider,
  ToolExecutor,
  AgentLogger,
  ToolDefinition,
  ToolResult,
  LLMMessage,
  LLMOptions,
} from '@nexora/contracts';
import {
  MiddlewarePipeline,
  type AgentMiddleware,
} from './middleware.js';
import {
  createIdleTimeout,
  IdleTimeoutError,
} from './idle-timeout.js';

export interface AgentRunnerOptions {
  /** 사고 패턴 */
  architecture: AgentArchitecture;
  /** LLM provider (FallbackLLMProvider 권장) */
  llm: LLMProvider;
  /** 도구 실행기 */
  tools: ToolExecutor;
  /** 메모리 (선택 — 없으면 stateless) */
  memory?: MemoryProvider;
  /** 로거 (선택) */
  logger?: AgentLogger;
  /** 미들웨어 목록 */
  middlewares?: AgentMiddleware[];
  /** Idle timeout (ms, 기본 600000 = 10분) */
  idleTimeoutMs?: number;
  /** Optional architecture-level suspend hook. Forwarded to RuntimeServices. */
  onSuspend?: RuntimeServices['onSuspend'];
}

const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

const NOOP_LOGGER: AgentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export class AgentRunner implements AgentRuntime {
  private readonly architecture: AgentArchitecture;
  private readonly llm: LLMProvider;
  private readonly tools: ToolExecutor;
  private readonly memory: MemoryProvider;
  private readonly logger: AgentLogger;
  private readonly pipeline: MiddlewarePipeline;
  private readonly idleTimeoutMs: number;
  private readonly onSuspend?: RuntimeServices['onSuspend'];
  /**
   * Active controllers per concurrent execute() call. abort() aborts ALL of them.
   * Per-call structure means concurrent executions don't trample each other's state.
   */
  private readonly activeControllers = new Set<AbortController>();
  /**
   * 실행 중 주입된 user 메시지 큐. steer() 가 push, 아키텍처 루프가 drainSteers 로 소비.
   * 런타임 인스턴스 단위(= 보통 thread 하나) — 동시 실행이 직렬화되는 in7 사용 패턴에서
   * 활성 실행 하나에 합류한다.
   */
  private readonly pendingSteers: LLMMessage[] = [];

  constructor(options: AgentRunnerOptions) {
    this.architecture = options.architecture;
    this.llm = options.llm;
    this.tools = options.tools;
    this.memory = options.memory ?? new NullMemory();
    this.logger = options.logger ?? NOOP_LOGGER;
    this.pipeline = new MiddlewarePipeline(options.middlewares ?? []);
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.onSuspend = options.onSuspend;
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent> {
    // Per-execute AbortController — propagated to LLM/tool calls so they actually
    // stop work when timeout fires or abort() is called.
    const controller = new AbortController();
    this.activeControllers.add(controller);

    const collectedEvents: AgentEvent[] = [];
    const toolInputs = new Map<string, unknown>();
    let finalContent = '';
    let executionError: Error | undefined;

    // Idle timeout fires AbortController on inactivity.
    const idle = createIdleTimeout(this.idleTimeoutMs, () => {
      controller.abort(new IdleTimeoutError(`Agent idle for ${this.idleTimeoutMs}ms`));
    });

    // Per-execute services snapshot — signal injected so architectures can forward.
    // Wrap the shared ToolExecutor so its execute() always sees this call's signal.
    // Wrap LLM with middleware so afterLLMCall actually fires.
    const services: RuntimeServices = {
      llm: wrapLLMWithMiddleware(this.llm, this.pipeline),
      tools: wrapToolExecutorWithSignal(this.tools, controller.signal),
      memory: this.memory,
      logger: this.logger,
      signal: controller.signal,
      drainSteers: () => (this.pendingSteers.length > 0 ? this.pendingSteers.splice(0) : []),
      onSuspend: this.onSuspend,
    };

    let loopGen: AsyncGenerator<AgentEvent> | null = null;

    try {
      // Pass actual ToolDefinition objects to beforeExecution when the executor
      // can expose them. Middleware such as approval gates can then wrap
      // execute(), and filters can remove tools before the architecture sees
      // them. Legacy executors that only expose summaries still get an audit
      // view, but cannot apply executable mutations.
      const beforeCtx = {
        input,
        tools: listExecutableTools(services.tools),
        systemPrompt: this.architecture.systemPrompt ?? '',
      };
      await this.pipeline.runBeforeExecution(beforeCtx);
      if (services.tools.withTools) {
        services.tools = services.tools.withTools(beforeCtx.tools);
      }

      loopGen = this.architecture.loop(services, input);
      const events = raceAgainstAbort(loopGen, controller.signal);

      for await (const event of events) {
        if (controller.signal.aborted) break;
        idle.reset();
        collectedEvents.push(event);

        if (event.type === 'tool_call') {
          toolInputs.set(event.id, event.input);
          const tool = (services.tools as { get?: (name: string) => unknown }).get?.(event.name);
          await this.pipeline.runBeforeToolCall({
            toolName: event.name,
            callId: event.id,
            input: event.input,
            tool: tool as never,
          });
        } else if (event.type === 'tool_result') {
          const toolInput = toolInputs.get(event.id);
          toolInputs.delete(event.id);
          await this.pipeline.runAfterToolCall({
            toolName: event.name,
            callId: event.id,
            input: toolInput,
            result: event.result as ToolResult,
            isError: event.isError,
          });
        } else if (event.type === 'done') {
          finalContent = event.content;
        }

        yield event;
      }
    } catch (err) {
      // AbortError thrown by raceAgainstAbort — distinguish timeout vs explicit abort
      const reason = controller.signal.reason;
      if (reason instanceof IdleTimeoutError) {
        const timeoutEvent: AgentEvent = {
          type: 'error',
          message: `Agent idle timeout (${this.idleTimeoutMs}ms)`,
        };
        collectedEvents.push(timeoutEvent);
        yield timeoutEvent;
      } else if (controller.signal.aborted) {
        const abortEvent: AgentEvent = { type: 'error', message: 'aborted' };
        collectedEvents.push(abortEvent);
        yield abortEvent;
      } else {
        executionError = err instanceof Error ? err : new Error(String(err));
        const errEvent: AgentEvent = {
          type: 'error',
          message: executionError.message,
        };
        collectedEvents.push(errEvent);
        yield errEvent;
      }
    } finally {
      idle.clear();
      // Close the underlying generator so any remaining `yield`s are aborted.
      // This is what prevents the architecture from continuing to run after timeout.
      if (loopGen) {
        try {
          await loopGen.return(undefined as unknown as AgentEvent);
        } catch {
          // ignore — generator may already be closed
        }
      }
      this.activeControllers.delete(controller);
      try {
        await this.pipeline.runAfterExecution({
          input,
          events: collectedEvents,
          finalContent,
          error: executionError,
        });
      } catch {
        // afterExecution 실패는 무시
      }
    }
  }

  abort(): void {
    for (const c of this.activeControllers) c.abort(new Error('aborted'));
  }

  /**
   * 실행 중인 에이전트에 user 메시지를 주입. 활성 실행이 있으면 steer 큐에 넣고 true —
   * 아키텍처 루프가 다음 반복(또는 종료 직전)에 drainSteers 로 꺼내 history 에 합류한다.
   * 활성 실행이 없으면 주입할 곳이 없으므로 false (호출자가 새 turn 으로 처리).
   */
  steer(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return this.activeControllers.size > 0;
    if (this.activeControllers.size === 0) return false;
    this.pendingSteers.push({ role: 'user', content: trimmed });
    return true;
  }
}

/** memory가 없을 때 사용하는 null 구현 */
class NullMemory implements MemoryProvider {
  async append(): Promise<void> {}
  async getHistory(): Promise<[]> { return []; }
  async compact(): Promise<null> { return null; }
  async clear(): Promise<void> {}
}

/**
 * Wrap an LLMProvider so before/after LLM middleware fires on provider calls.
 */
function wrapLLMWithMiddleware(
  inner: LLMProvider,
  pipeline: MiddlewarePipeline,
): LLMProvider {
  return {
    stream: async function* (messages, options) {
      const call = await prepareLLMCall(messages, options, pipeline);
      yield* inner.stream(call.messages, call.options);
    },
    async complete(messages, options) {
      const call = await prepareLLMCall(messages, options, pipeline);
      const response = await inner.complete(call.messages, call.options);
      try {
        await pipeline.runAfterLLMCall({ response, usage: response.usage });
      } catch {
        // middleware failure must not break the LLM call
      }
      return response;
    },
  };
}

async function prepareLLMCall(
  messages: LLMMessage[],
  options: LLMOptions | undefined,
  pipeline: MiddlewarePipeline,
): Promise<{ messages: LLMMessage[]; options?: LLMOptions }> {
  const beforeCtx = {
    messages,
    systemPrompt: options?.systemPrompt ?? '',
  };
  await pipeline.runBeforeLLMCall(beforeCtx);
  const nextOptions = options || beforeCtx.systemPrompt
    ? { ...options, systemPrompt: beforeCtx.systemPrompt }
    : undefined;
  return {
    messages: beforeCtx.messages,
    options: nextOptions,
  };
}

/**
 * Wrap a ToolExecutor so every execute() sees the per-call signal.
 * Preserves the optional `get`/`has` methods CoreToolExecutor exposes.
 */
function wrapToolExecutorWithSignal(inner: ToolExecutor, signal: AbortSignal): ToolExecutor {
  const wrapped: ToolExecutor = {
    list: () => inner.list(),
    execute: (name, callId, input, callerSignal) => {
      // If caller already passed a signal, downstream tool-executor combines them.
      // Otherwise pass our run-level signal.
      return inner.execute(name, callId, input, callerSignal ?? signal);
    },
  };
  if (inner.executeBatch) {
    wrapped.executeBatch = (calls, callerSignal) =>
      inner.executeBatch?.(calls, callerSignal ?? signal) ?? Promise.resolve([]);
  }
  // Pass-through optional helpers (for middleware that calls .get()).
  const innerWithExtras = inner as ToolExecutor & {
    get?: (name: string) => unknown;
    has?: (name: string) => boolean;
  };
  if (innerWithExtras.get) {
    (wrapped as ToolExecutor & { get: (name: string) => unknown }).get =
      innerWithExtras.get.bind(innerWithExtras);
  }
  if (innerWithExtras.withTools) {
    (wrapped as ToolExecutor & { withTools: (tools: ToolDefinition[]) => ToolExecutor }).withTools =
      (tools) => wrapToolExecutorWithSignal(innerWithExtras.withTools?.(tools) ?? inner, signal);
  }
  if (innerWithExtras.has) {
    (wrapped as ToolExecutor & { has: (name: string) => boolean }).has =
      innerWithExtras.has.bind(innerWithExtras);
  }
  return wrapped;
}

function listExecutableTools(executor: ToolExecutor): ToolDefinition[] {
  if (executor.get) {
    return executor
      .list()
      .map((summary) => executor.get?.(summary.name))
      .filter((tool): tool is ToolDefinition => Boolean(tool));
  }
  return executor.list() as unknown as ToolDefinition[];
}

/**
 * Race a source generator against an AbortSignal. When the signal aborts,
 * we close the source via .return() and throw the abort reason.
 *
 * IMPORTANT: every iteration registers an `abort` listener and MUST remove it
 * when the source-next branch wins the race — otherwise the listener accumulates
 * one entry per yield (long generators → memory leak + EventEmitter warnings).
 */
async function* raceAgainstAbort<T>(
  source: AsyncGenerator<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  while (true) {
    if (signal.aborted) {
      try { await source.return(undefined as unknown as T); } catch { /* ignore */ }
      throw signal.reason ?? new Error('aborted');
    }

    const next = source.next();

    let onAbort: (() => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
      // No { once: true } — we manage removal explicitly in the finally below.
      signal.addEventListener('abort', onAbort);
    });

    let result: IteratorResult<T>;
    try {
      result = await Promise.race([next, abortPromise]);
    } catch (err) {
      try { await source.return(undefined as unknown as T); } catch { /* ignore */ }
      throw err;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }

    if (result.done) return;
    yield result.value;
  }
}
