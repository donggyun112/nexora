/**
 * PiAgentRunner — AgentRuntime 구현, pi-agent-core Agent 클래스 기반.
 *
 * Stage 1의 PiAiProvider와 별개 경로: PiAgentRunner는 LLMProvider 대신
 * pi-ai의 Model<Api>를 직접 받아 Agent 내부 streamFn으로 위임한다.
 *
 * 핵심 변환: Agent.subscribe(listener) → AsyncGenerator<AgentEvent>.
 * subscribe 콜백이 이벤트를 큐에 push, execute()가 큐에서 shift해 yield.
 */

import { Agent } from '@earendil-works/pi-agent-core';
import type {
  AgentRuntime, AgentInput, AgentEvent,
  ToolDefinition, ToolExecutor, MemoryProvider, AgentLogger,
} from '@nexora/contracts';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { AgentMiddleware } from '../middleware.js';
import { toAgentMessages, convertToLlm } from './message-bridge.js';
import { toAgentTools } from './tool-bridge.js';
import { fromPiEvent } from './event-bridge.js';
import { middlewaresToAgentLoopConfig } from './middleware-bridge.js';

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

/** Per-execute context shared between execute() and abort(). */
interface ExecCtx {
  setDone: () => void;
  wake: () => void;
  aborted: boolean;
}

export class PiAgentRunner implements AgentRuntime {
  private readonly options: PiAgentRunnerOptions;
  private currentAgent?: { abort: () => void };
  private currentExec?: ExecCtx;

  constructor(options: PiAgentRunnerOptions) {
    this.options = options;
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent> {
    const middlewares = this.options.middlewares ?? [];
    const toolsByName = new Map(this.options.tools.map(t => [t.name, t]));
    const bridge = middlewaresToAgentLoopConfig(middlewares, name => toolsByName.get(name));

    const agent = new Agent({
      initialState: {
        systemPrompt: this.options.systemPrompt,
        model: this.options.model,
        thinkingLevel: 'off',
        tools: toAgentTools(this.options.tools, this.options.toolExecutor),
        messages: [],
      },
      convertToLlm,
      beforeToolCall: bridge.hooks.beforeToolCall,
      afterToolCall: bridge.hooks.afterToolCall,
      getApiKey: this.options.getApiKey,
    } as never);

    this.currentAgent = agent as unknown as { abort: () => void };

    const queue: AgentEvent[] = [];
    let done = false;
    let waitResolve: (() => void) | null = null;
    const wake = () => {
      const r = waitResolve;
      if (r) { waitResolve = null; r(); }
    };
    const setDone = () => { done = true; wake(); };

    const execCtx: ExecCtx = { setDone, wake, aborted: false };
    this.currentExec = execCtx;

    // pi-agent-core's subscribe signature uses its own event union that doesn't
    // overlap with @nexora/contracts AgentEvent. Cast through unknown to bridge.
    const unsubscribe = (agent.subscribe as unknown as (cb: (piEvent: never) => Promise<void>) => () => void)(async (piEvent: never) => {
      // Drop events that arrive after abort to avoid polluting the queue.
      if (execCtx.aborted) return;
      for (const nexEvent of fromPiEvent(piEvent)) {
        queue.push(nexEvent);
      }
      wake();
      const pe = piEvent as { type: string };
      if (pe.type === 'agent_end') {
        setDone();
      }
    });

    const collectedEvents: AgentEvent[] = [];
    let finalContent = '';
    let executionError: Error | undefined;
    let doneEmitted = false;

    try {
      await bridge.runBeforeExecution(input);
      const messages = toAgentMessages(input, {
        api: this.options.model.api as string,
        provider: this.options.model.provider as string,
      });
      // Fire-and-forget — events arrive via subscribe.
      agent.prompt(messages as never).catch((err: unknown) => {
        executionError = err instanceof Error ? err : new Error(String(err));
        setDone();
      });

      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>(r => { waitResolve = r; });
          continue;
        }
        const ev = queue.shift()!;
        collectedEvents.push(ev);
        if (ev.type === 'done') {
          finalContent = (ev as { type: 'done'; content: string }).content;
          doneEmitted = true;
        }
        yield ev;
      }

      // Yield abort error if abort() was called before a normal done was emitted.
      if (execCtx.aborted && !doneEmitted) {
        const abortEvent: AgentEvent = { type: 'error', message: 'aborted' };
        collectedEvents.push(abortEvent);
        yield abortEvent;
      } else if (executionError && !doneEmitted) {
        // Only emit error if we haven't already successfully completed.
        const errEvent: AgentEvent = { type: 'error', message: executionError.message };
        collectedEvents.push(errEvent);
        yield errEvent;
      }
    } finally {
      unsubscribe();
      this.currentAgent = undefined;
      this.currentExec = undefined;
      try {
        await bridge.runAfterExecution(input, collectedEvents, finalContent, executionError);
      } catch {
        // afterExecution failures must not break the runner.
      }
    }
  }

  abort(): void {
    const exec = this.currentExec;
    if (exec) {
      exec.aborted = true;
      exec.setDone();
    }
    this.currentAgent?.abort();
  }
}
