/**
 * LocalExecutionHarness — in-process AgentArchitecture execution driver.
 *
 * It owns per-run services, middleware hooks, idle timeout, cancellation, event
 * accounting, and steering. AgentRunner stays as the public facade.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentArchitecture,
  AgentEvent,
  AgentInput,
  AgentLogger,
  BackgroundTaskRegistry,
  BackgroundTaskResult,
  TriggerHost,
  ResourceLock,
  ExecutionHarness,
  LLMMessage,
  LLMOptions,
  LLMProvider,
  MemoryProvider,
  RuntimeServices,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
  FileReadState,
  TranscriptStore,
  WorkspaceAcquireOptions,
  WorkspaceProvider,
  WorkspaceSession,
  EffectLedger,
} from '@dongkseo/contracts';
import {
  EffectWriteFencedError,
  InMemoryBackgroundTaskRegistry,
  InMemoryTriggerHost,
} from '@dongkseo/contracts';
import { TranscriptRecorder } from './transcript-recorder.js';
import { bindFallbackContext, type FallbackSink } from './llm/index.js';
import {
  MiddlewarePipeline,
  type AgentMiddleware,
} from './middleware.js';
import {
  createIdleTimeout,
  IdleTimeoutError,
} from './idle-timeout.js';
import {
  DurableExecutionError,
  DurableToolExecutor,
  RunLeaseContendedError,
} from './durable-tool-executor.js';

export interface DurableExecutionOptions {
  /** Durable store for effect intent and results. */
  ledger: EffectLedger;
  /** Stable id for this execution attempt. Tool call ids are scoped underneath it. */
  runId: string | ((input: AgentInput) => string);
  /** Unique worker identity. Defaults to a fresh UUID for every execute() call. */
  owner?: (input: AgentInput) => string;
  /** Lease lifetime. The tool boundary renews it before every new effect. */
  leaseTtlMs?: number;
}

export interface LocalExecutionHarnessOptions {
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
  /**
   * Optional per-round stop policy. Forwarded to RuntimeServices — the architecture
   * asks after each tool round whether to finish instead of taking another LLM turn
   * (budget ceilings, verification gates, app-level turn limits).
   */
  shouldStopAfterTurn?: RuntimeServices['shouldStopAfterTurn'];
  /** Optional workspace provider. When set, tools receive a per-run workspace session. */
  workspaceProvider?: WorkspaceProvider;
  /** Per-runtime seed dirs forwarded into workspaceProvider.acquire(). See WorkspaceAcquireOptions.seedDirs. */
  workspaceSeedDirs?: WorkspaceAcquireOptions['seedDirs'];
  /** Rich transcript store (system of record). With conversationId, the harness records every turn. */
  transcript?: TranscriptStore;
  /** Conversation key for transcript recording. */
  conversationId?: string;
  /** Shared background-task registry injected into every tool ToolContext. Defaults to a per-harness InMemoryBackgroundTaskRegistry. */
  backgroundTasks?: BackgroundTaskRegistry;
  /** Post-turn result sink for background tasks, forwarded to ToolContext.deliverResult. */
  deliverResult?: (result: BackgroundTaskResult) => void | Promise<void>;
  /** Trigger host injected into every tool ToolContext. Defaults to a per-harness InMemoryTriggerHost. */
  triggers?: TriggerHost;
  /**
   * Resource lock injected into every tool ToolContext (write/edit/store serialize
   * their read-modify-write through it). NO per-harness default: pass the SAME
   * instance to a set of sibling runtimes (e.g. a parallel delegate fan-out) so
   * same-key writes across them serialize; leave undefined for a single agent.
   */
  resourceLock?: ResourceLock;
  /** Opt-in durable tool execution. Existing non-durable callers remain unchanged. */
  durability?: DurableExecutionOptions;
}

const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

const NOOP_LOGGER: AgentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export class LocalExecutionHarness implements ExecutionHarness {
  private readonly architecture: AgentArchitecture;
  private readonly llm: LLMProvider;
  private readonly tools: ToolExecutor;
  private readonly memory: MemoryProvider;
  private readonly logger: AgentLogger;
  private readonly pipeline: MiddlewarePipeline;
  private readonly idleTimeoutMs: number;
  private readonly onSuspend?: RuntimeServices['onSuspend'];
  private readonly shouldStopAfterTurn?: RuntimeServices['shouldStopAfterTurn'];
  private readonly workspaceProvider?: WorkspaceProvider;
  private readonly workspaceSeedDirs?: WorkspaceAcquireOptions['seedDirs'];
  private readonly transcript?: TranscriptStore;
  private readonly conversationId?: string;
  private readonly backgroundTasks: BackgroundTaskRegistry;
  private readonly deliverResult?: (result: BackgroundTaskResult) => void | Promise<void>;
  private readonly triggers: TriggerHost;
  private readonly resourceLock?: ResourceLock;
  private readonly durability?: DurableExecutionOptions;
  /**
   * Per-harness file-read history shared into the tool context so the read tool
   * can dedup unchanged re-reads. Lives for the harness lifetime (survives across
   * turns) unless the app already supplies its own readFileState in the base
   * context, which takes precedence.
   */
  private readonly readFileState = new Map<string, FileReadState>();
  /** The recorder for the currently-active execute() — used by steer(). Concurrent execute() calls are not supported when transcript recording is enabled (same single-active assumption as pendingSteers). */
  private activeRecorder: TranscriptRecorder | null = null;
  /** In-flight steer record() promises for the active execute() — awaited before flush so steers aren't lost. */
  private activeSteerWrites: Promise<void>[] = [];
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

  constructor(options: LocalExecutionHarnessOptions) {
    this.architecture = options.architecture;
    this.llm = options.llm;
    this.tools = options.tools;
    this.memory = options.memory ?? new NullMemory();
    this.logger = options.logger ?? NOOP_LOGGER;
    this.pipeline = new MiddlewarePipeline(options.middlewares ?? []);
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.onSuspend = options.onSuspend;
    this.shouldStopAfterTurn = options.shouldStopAfterTurn;
    this.workspaceProvider = options.workspaceProvider;
    this.workspaceSeedDirs = options.workspaceSeedDirs;
    this.transcript = options.transcript;
    this.conversationId = options.conversationId;
    this.backgroundTasks = options.backgroundTasks ?? new InMemoryBackgroundTaskRegistry();
    this.deliverResult = options.deliverResult;
    this.triggers = options.triggers ?? new InMemoryTriggerHost();
    this.resourceLock = options.resourceLock;
    this.durability = options.durability;
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent> {
    // Per-execute AbortController — propagated to LLM/tool calls so they actually
    // stop work when timeout fires or abort() is called.
    const controller = new AbortController();
    this.activeControllers.add(controller);

    const recorder = (this.transcript && this.conversationId)
      ? new TranscriptRecorder(this.transcript, this.conversationId)
      : null;
    this.activeRecorder = recorder;
    this.activeSteerWrites = [];
    const collectedEvents: AgentEvent[] = [];
    const toolInputs = new Map<string, unknown>();
    let finalContent = '';
    let executionError: Error | undefined;

    // Idle timeout fires AbortController on inactivity.
    const idle = createIdleTimeout(this.idleTimeoutMs, () => {
      controller.abort(new IdleTimeoutError(`Agent idle for ${this.idleTimeoutMs}ms`));
    });

    let workspace: WorkspaceSession | undefined;
    let toolExecutor = this.tools;
    let effectLease: { runId: string; owner: string; token: number } | undefined;
    let loopGen: AsyncGenerator<AgentEvent> | null = null;
    // Side channel for tool-emitted progress events (ctx.emitProgress). Merged
    // into the yielded stream so a tool can surface activity (e.g. a delegate
    // relaying its child subagent's events) while it is still executing.
    const progress = createProgressChannel();

    try {
      if (this.durability) {
        const runId = typeof this.durability.runId === 'function'
          ? this.durability.runId(input)
          : this.durability.runId;
        if (!runId) throw new Error('Durable execution runId must not be empty');
        const owner = this.durability.owner?.(input) ?? randomUUID();
        const token = await this.durability.ledger.acquire(
          runId,
          owner,
          this.durability.leaseTtlMs ?? 60_000,
        );
        if (token === 0) throw new RunLeaseContendedError(runId);
        effectLease = { runId, owner, token };
      }

      // A contending worker must not append transcript state before it owns the run.
      if (recorder && !input.resumeContext) {
        try { await recorder.recordUserInput(input); } catch { /* best-effort */ }
      }

      const baseToolContext = this.tools.getContext?.();
      if (this.workspaceProvider) {
        if (!baseToolContext || !this.tools.withContext) {
          throw new Error('workspaceProvider requires a ToolExecutor with getContext() and withContext()');
        }
        workspace = await this.workspaceProvider.acquire({
          baseWorkdir: baseToolContext.workdir,
          input,
          seedDirs: this.workspaceSeedDirs,
        });
      }
      // Inject steerSelf (and the acquired workspace, if any) into the tool
      // context so tools can re-enter their own parent loop via a steer — the
      // channel background-subagent delegation uses to fold a child result back
      // into this turn. Requires a context-capable executor; otherwise tools see
      // steerSelf === undefined and fall back to a new-turn delivery.
      if (baseToolContext && this.tools.withContext) {
        toolExecutor = this.tools.withContext({
          ...baseToolContext,
          ...(workspace ? { workdir: workspace.root, workspace } : {}),
          steerSelf: (message: string) => this.steer(message),
          emitProgress: (message: string, agent?: string) =>
            progress.push({ type: 'progress', message, ...(agent ? { agent } : {}) }),
          backgroundTasks: this.backgroundTasks,
          deliverResult: this.deliverResult,
          triggers: this.triggers,
          resourceLock: this.resourceLock,
          readFileState: baseToolContext.readFileState ?? this.readFileState,
        });
      }

      if (this.durability && effectLease) {
        const durability = this.durability;
        const lease = effectLease;
        toolExecutor = new DurableToolExecutor({
          inner: toolExecutor,
          ledger: durability.ledger,
          runId: lease.runId,
          fencingToken: lease.token,
          renewLease: async () => {
            const token = await durability.ledger.acquire(
              lease.runId,
              lease.owner,
              durability.leaseTtlMs ?? 60_000,
            );
            if (token === 0) throw new RunLeaseContendedError(lease.runId);
            lease.token = token;
            return token;
          },
        });
      }

      // Per-execute services snapshot — signal injected so architectures can forward.
      // Wrap the shared ToolExecutor so its execute() always sees this call's signal.
      // Wrap LLM with middleware so afterLLMCall actually fires.
      const fallbackSink: FallbackSink | undefined = recorder
        ? { record: (r) => { void recorder.recordFallback(r); } }
        : undefined;
      const services: RuntimeServices = {
        llm: bindFallbackContext(wrapLLMWithMiddleware(this.llm, this.pipeline), fallbackSink),
        tools: wrapToolExecutorWithSignal(toolExecutor, controller.signal),
        memory: this.memory,
        logger: this.logger,
        signal: controller.signal,
        drainSteers: () => (this.pendingSteers.length > 0 ? this.pendingSteers.splice(0) : []),
        onSuspend: this.onSuspend,
        shouldStopAfterTurn: this.shouldStopAfterTurn,
      };

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
      const events = mergeWithProgress(raceAgainstAbort(loopGen, controller.signal), progress);

      for await (const event of events) {
        if (controller.signal.aborted) break;
        idle.reset();
        collectedEvents.push(event);

        if (recorder) {
          try { await recorder.onEvent(event); } catch { /* best-effort */ }
        }

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
      if (err instanceof DurableExecutionError || err instanceof EffectWriteFencedError) {
        executionError = err;
        throw err;
      }
      // AbortError thrown by raceAgainstAbort — distinguish timeout vs explicit abort.
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
      progress.close();
      if (recorder) {
        try { await Promise.all(this.activeSteerWrites); } catch { /* best-effort */ }
        try { await recorder.flush(); } catch { /* best-effort */ }
      }
      this.activeRecorder = null;
      this.activeSteerWrites = [];
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
      if (workspace) {
        try {
          await workspace.cleanup();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn('workspace.cleanup.failed', { error: message });
        }
      }
      if (this.durability && effectLease) {
        try {
          await this.durability.ledger.release(effectLease.runId, effectLease.owner);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn('effect-lease.release.failed', { error: message });
        }
      }
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
    const steerWrite = this.activeRecorder?.recordSteer(trimmed);
    if (steerWrite) this.activeSteerWrites.push(steerWrite.catch(() => {}));
    return true;
  }
}

/** memory가 없을 때 사용하는 null 구현 */
class NullMemory implements MemoryProvider {
  async append(): Promise<void> {}
  async getHistory(): Promise<LLMMessage[]> { return []; }
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
  if (innerWithExtras.withContext) {
    wrapped.withContext = (context) =>
      wrapToolExecutorWithSignal(innerWithExtras.withContext?.(context) ?? inner, signal);
  }
  if (innerWithExtras.getContext) {
    wrapped.getContext = innerWithExtras.getContext.bind(innerWithExtras);
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

/**
 * Single-consumer push channel for tool-emitted progress events. `push` enqueues
 * (or hands off to a waiting `next`), `close` ends iteration. The merge below is
 * the sole consumer, so at most one `next()` is ever pending.
 */
interface ProgressChannel {
  push(event: AgentEvent): void;
  close(): void;
  next(): Promise<IteratorResult<AgentEvent>>;
}

function createProgressChannel(): ProgressChannel {
  const queue: AgentEvent[] = [];
  let waiting: ((r: IteratorResult<AgentEvent>) => void) | null = null;
  let closed = false;
  const DONE: IteratorResult<AgentEvent> = { value: undefined as never, done: true };
  return {
    push(event: AgentEvent): void {
      if (closed) return;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(DONE);
      }
    },
    next(): Promise<IteratorResult<AgentEvent>> {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift() as AgentEvent, done: false });
      if (closed) return Promise.resolve(DONE);
      return new Promise((resolve) => { waiting = resolve; });
    },
  };
}

/**
 * Merge the architecture event stream with the progress side channel. Progress
 * events are yielded as they arrive (so they interleave with — and during — the
 * architecture's own events). The architecture stream is primary: when it ends,
 * the merge ends; when it throws (abort/timeout/error), the error propagates so
 * the harness's existing catch handles it. Late progress emitted after the loop
 * has already ended is dropped (best-effort ancillary signal).
 */
async function* mergeWithProgress(
  source: AsyncGenerator<AgentEvent>,
  channel: ProgressChannel,
): AsyncGenerator<AgentEvent> {
  let srcNext = source.next();
  let chanNext = channel.next();
  let chanOpen = true;

  while (true) {
    if (!chanOpen) {
      const r = await srcNext;
      if (r.done) return;
      yield r.value;
      srcNext = source.next();
      continue;
    }

    const winner = await Promise.race([
      srcNext.then((r) => ({ from: 'src' as const, r })),
      chanNext.then((r) => ({ from: 'chan' as const, r })),
    ]);

    if (winner.from === 'src') {
      if (winner.r.done) return;
      yield winner.r.value;
      srcNext = source.next();
    } else if (winner.r.done) {
      chanOpen = false;
    } else {
      yield winner.r.value;
      chanNext = channel.next();
    }
  }
}
