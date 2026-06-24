/**
 * createWorkflowRuntime — expose a WorkflowContract as an AgentRuntime.
 *
 * This is the seam that lets a workflow be invoked exactly like any other agent:
 * its `execute(input)` runs the workflow on a `WorkflowEngine` and surfaces the
 * outcome as the standard AgentEvent stream (`progress` per step, then `done`
 * or `error`). Wrapped in an AgentCard via `bootstrapWorkflow`, the workflow
 * becomes a delegatable capability — no agent ever names it, they reach it by
 * topic/capability like everything else.
 *
 * The engine is taken as the minimal `WorkflowRunnerLike` surface (just `run`)
 * so this stays trivially testable and free of engine internals.
 */

import type {
  AgentInput,
  AgentEvent,
  AgentRuntime,
  WorkflowContract,
} from '@dongkseo/contracts';
import type { WorkflowExecutionInput, WorkflowExecutionResult } from './engine.js';

/** Minimal engine surface the runtime needs. `WorkflowEngine` satisfies it. */
export interface WorkflowRunnerLike {
  run(
    workflow: WorkflowContract,
    input?: WorkflowExecutionInput,
  ): Promise<WorkflowExecutionResult>;
}

export interface WorkflowRuntimeOptions {
  /**
   * Map the incoming AgentInput to the workflow's initial input (referenced by
   * `template`/`fromStep` step inputs with key='input'). Default: parse
   * `input.prompt` as JSON, falling back to the raw string. This round-trips a
   * structured payload that `bootstrapWorkflow` packs into `prompt` as JSON.
   */
  toWorkflowInput?: (input: AgentInput) => unknown;
}

function defaultToWorkflowInput(input: AgentInput): unknown {
  const prompt = input.prompt ?? '';
  if (prompt === '') return undefined;
  try {
    return JSON.parse(prompt);
  } catch {
    return prompt;
  }
}

export function createWorkflowRuntime(
  engine: WorkflowRunnerLike,
  workflow: WorkflowContract,
  options: WorkflowRuntimeOptions = {},
): AgentRuntime {
  const toWorkflowInput = options.toWorkflowInput ?? defaultToWorkflowInput;
  let aborted = false;

  return {
    async *execute(input: AgentInput): AsyncGenerator<AgentEvent> {
      const result = await engine.run(workflow, { input: toWorkflowInput(input) });

      // engine.run is not interruptible; abort() only suppresses emission.
      if (aborted) return;

      for (const step of result.steps) {
        yield {
          type: 'progress',
          message: `step ${step.stepId} ${step.isError ? 'failed' : 'ok'}`,
          agent: workflow.name,
        };
      }

      if (result.status === 'completed') {
        yield { type: 'done', content: JSON.stringify(result), toolCalls: [] };
      } else {
        yield { type: 'error', message: result.error ?? `workflow ${workflow.name} failed` };
      }
    },

    abort(): void {
      // The engine has no mid-run cancellation; flag so a completing run does
      // not emit its terminal event.
      aborted = true;
    },
  };
}
