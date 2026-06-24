/**
 * bootstrapWorkflow — wire a WorkflowContract's trigger to its execution.
 *
 * Mirrors `bootstrapAgent` for workflows. By trigger type:
 *   - topic   → expose the workflow AS an agent (via injected `bootstrapAgent`):
 *               it subscribes to `trigger.topic` and becomes a delegatable
 *               capability. All transport plumbing (reply, publish, registry)
 *               is reused — nothing duplicated here.
 *   - cron    → schedule `engine.run` on the provided `scheduler`. We do NOT
 *               parse the cron `expression` (CronScheduler is interval-based by
 *               design); the caller injects `nextRunAt` — same "bring your own
 *               cron lib" philosophy the scheduler already follows.
 *   - manual  → no auto-wiring; the returned handle exposes `run(input)`.
 *
 * `bootstrapAgent` is INJECTED (not imported) so this package keeps its
 * contracts-only dependency footprint — the composition root passes in
 * `@dongkseo/core`'s bootstrapAgent. Same DI principle as the transport/registry
 * factories: the framework layer never hard-couples to a heavier layer.
 */

import type {
  AgentCard,
  AgentInput,
  AgentRegistry,
  AgentRuntime,
  ContextLoader,
  EventTransport,
  MessageEnvelope,
  TopicString,
  WorkflowContract,
} from '@dongkseo/contracts';
import type { WorkflowRunnerLike, WorkflowRuntimeOptions } from './workflow-runtime.js';
import { createWorkflowRuntime } from './workflow-runtime.js';
import type { CronScheduler } from './cron.js';

/** Structural type of `@dongkseo/core`'s `bootstrapAgent` (injected, not imported). */
export type BootstrapAgentFn = (options: {
  card: AgentCard;
  contextLoader: ContextLoader;
  transport: EventTransport;
  registry?: AgentRegistry;
  createRuntime: (args: {
    context: unknown;
    envelope: MessageEnvelope;
  }) => AgentRuntime | Promise<AgentRuntime>;
  toAgentInput: (envelope: MessageEnvelope) => AgentInput | Promise<AgentInput>;
}) => Promise<{ shutdown(): Promise<void> }>;

export interface WorkflowCardOverrides extends Partial<Omit<AgentCard, 'name'>> {
  name?: string;
}

/** Build an AgentCard from a workflow contract. Pure. */
export function workflowCard(
  workflow: WorkflowContract,
  overrides: WorkflowCardOverrides = {},
): AgentCard {
  const subscribes: TopicString[] =
    workflow.trigger.type === 'topic' ? [workflow.trigger.topic] : [];

  return {
    name: workflow.name,
    version: '0.1.0',
    description: workflow.description,
    capabilities: [],
    subscribes,
    publishes: [],
    tools: [],
    architecture: 'workflow',
    ...overrides,
  };
}

export interface BootstrapWorkflowOptions {
  workflow: WorkflowContract;
  engine: WorkflowRunnerLike;
  transport: EventTransport;
  /** Required for topic triggers (passed through to bootstrapAgent). */
  contextLoader?: ContextLoader;
  /** Required for topic triggers — injected from @dongkseo/core. */
  bootstrapAgent?: BootstrapAgentFn;
  registry?: AgentRegistry;
  /** Required for cron triggers. */
  scheduler?: CronScheduler;
  /** Required for cron triggers — computes the next run time (ms epoch). */
  nextRunAt?: (now: number) => number;
  /** Card field overrides for the topic path (e.g. capabilities). */
  cardOverrides?: WorkflowCardOverrides;
  /** Input mapping forwarded to the workflow runtime. */
  toWorkflowInput?: WorkflowRuntimeOptions['toWorkflowInput'];
}

export interface RunningWorkflow {
  shutdown(): Promise<void>;
  /** Run the workflow on demand (always present; the only path for manual triggers). */
  run(input?: unknown): Promise<void>;
}

function defaultToAgentInput(envelope: MessageEnvelope): AgentInput {
  const payload = (envelope as { payload?: unknown }).payload;
  const prompt =
    typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  return { prompt };
}

export async function bootstrapWorkflow(
  options: BootstrapWorkflowOptions,
): Promise<RunningWorkflow> {
  const { workflow, engine, transport } = options;

  const run = async (input?: unknown): Promise<void> => {
    await engine.run(workflow, { input });
  };

  const trigger = workflow.trigger;

  if (trigger.type === 'topic') {
    if (!options.bootstrapAgent || !options.contextLoader) {
      throw new Error(
        `bootstrapWorkflow: topic trigger for "${workflow.name}" requires ` +
        `both 'bootstrapAgent' and 'contextLoader'.`,
      );
    }
    const running = await options.bootstrapAgent({
      card: workflowCard(workflow, options.cardOverrides),
      contextLoader: options.contextLoader,
      transport,
      registry: options.registry,
      createRuntime: () =>
        createWorkflowRuntime(engine, workflow, { toWorkflowInput: options.toWorkflowInput }),
      toAgentInput: defaultToAgentInput,
    });
    return { shutdown: () => running.shutdown(), run };
  }

  if (trigger.type === 'cron') {
    if (!options.scheduler || !options.nextRunAt) {
      throw new Error(
        `bootstrapWorkflow: cron trigger for "${workflow.name}" requires both ` +
        `'scheduler' and 'nextRunAt' (cron expressions are not parsed — inject a ` +
        `next-run function).`,
      );
    }
    const jobId = `workflow:${workflow.name}`;
    const scheduler = options.scheduler;
    const nextRunAt = options.nextRunAt;
    scheduler.schedule({ id: jobId, nextRunAt, run: () => run() });
    return {
      shutdown: async () => { scheduler.unschedule(jobId); },
      run,
    };
  }

  // manual: no auto-wiring; caller invokes run() explicitly.
  return { shutdown: async () => {}, run };
}
