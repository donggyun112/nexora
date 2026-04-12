/**
 * Budget middleware — records LLM cost after every agent execution and
 * blocks/warns/pauses when a budget policy is exceeded.
 *
 * Plugs into the MiddlewarePipeline. After each execution, it sums up
 * token usage from AgentEvents (the 'done' event carries token metadata
 * when the LLM provider populates it) and records a CostEvent.
 *
 * Usage:
 *   const tracker = new InMemoryBudgetTracker();
 *   await tracker.addPolicy({
 *     id: 'tenant-A-daily',
 *     scope: { type: 'tenant', tenantId: 'tenant-A' },
 *     maxCostUsd: 10.0,
 *     window: { type: 'daily' },
 *     onExceed: 'block',
 *   });
 *
 *   const runner = new AgentRunner({
 *     middlewares: [createBudgetMiddleware({ tracker, agentName: 'my-agent', tenantId: 'tenant-A' })],
 *   });
 */

import type { BudgetTracker, CostEvent, AgentLogger } from '@nexora/contracts';
import { estimateCostUsd } from './budget.js';

interface BudgetMiddlewareContext {
  tools: unknown[];
  systemPrompt: string;
  input: unknown;
}

interface AfterContext {
  events: unknown[];
  finalContent: string;
  error?: Error;
  input: unknown;
}

interface AgentMiddleware {
  name: string;
  beforeExecution?(ctx: BudgetMiddlewareContext): Promise<void> | void;
  afterExecution?(ctx: AfterContext): Promise<void> | void;
}

export interface BudgetMiddlewareOptions {
  tracker: BudgetTracker;
  agentName: string;
  tenantId: string;
  /** Model name for cost estimation. Default: 'claude-sonnet-4-5' */
  model?: string;
  /** Logger for budget warnings/blocks. */
  logger?: AgentLogger;
}

export class BudgetExceededError extends Error {
  constructor(public readonly policyId: string, public readonly spent: number, public readonly limit: number) {
    super(`Budget exceeded: policy "${policyId}" spent $${spent.toFixed(4)} / $${limit.toFixed(2)}`);
    this.name = 'BudgetExceededError';
  }
}

const NOOP_LOGGER: AgentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

export function createBudgetMiddleware(options: BudgetMiddlewareOptions): AgentMiddleware {
  const {
    tracker,
    agentName,
    tenantId,
    model = 'claude-sonnet-4-5',
    logger = NOOP_LOGGER,
  } = options;

  return {
    name: 'budget',

    async beforeExecution(): Promise<void> {
      // C5 FIX: check ALL applicable scopes, not just tenant-agent.
      // A global policy with onExceed:'block' must also block.
      const scopes: import('@nexora/contracts').BudgetScope[] = [
        { type: 'global' },
        { type: 'tenant', tenantId },
        { type: 'agent', agentName },
        { type: 'tenant-agent', tenantId, agentName },
      ];

      for (const scope of scopes) {
        const statuses = await tracker.check(scope);
        for (const status of statuses) {
          if (status.exceeded) {
            const policy = (await tracker.listPolicies()).find(p => p.id === status.policyId);
            if (policy?.onExceed === 'block') {
              throw new BudgetExceededError(status.policyId, status.spent, status.limit);
            }
            if (policy?.onExceed === 'warn') {
              logger.warn(`Budget warning: ${status.policyId} at $${status.spent.toFixed(4)} / $${status.limit.toFixed(2)}`);
            }
          }
        }
      }
    },

    async afterExecution(ctx: AfterContext): Promise<void> {
      // C6 FIX: skip recording if the execution errored — failed/blocked
      // runs should not accrue cost. Only record when the agent actually
      // produced a response.
      if (ctx.error) {
        logger.debug('budget.skip (execution errored)', { agentName, tenantId });
        return;
      }

      const contentLength = ctx.finalContent?.length ?? 0;
      if (contentLength === 0) {
        logger.debug('budget.skip (no content)', { agentName, tenantId });
        return;
      }

      const inputEstimate = 2000;
      const outputTokens = Math.ceil(contentLength / 4);

      // Count tool calls for a more accurate input estimate
      const toolCalls = (ctx.events as { type?: string }[])
        .filter(e => e.type === 'tool_call').length;
      const totalInputTokens = inputEstimate + toolCalls * 500;

      const costUsd = estimateCostUsd(model, totalInputTokens, outputTokens);

      const event: CostEvent = {
        agentName,
        tenantId,
        model,
        inputTokens: totalInputTokens,
        outputTokens,
        costUsd,
        timestamp: Date.now(),
      };

      const statuses = await tracker.record(event);

      for (const status of statuses) {
        if (status.exceeded) {
          const policy = (await tracker.listPolicies()).find(p => p.id === status.policyId);
          if (policy?.onExceed === 'warn' || policy?.onExceed === 'pause') {
            logger.warn(
              `Budget ${policy.onExceed}: ${status.policyId} spent $${status.spent.toFixed(4)} / $${status.limit.toFixed(2)}`,
            );
          }
        }
      }

      logger.debug('budget.record', {
        agentName,
        tenantId,
        costUsd: costUsd.toFixed(6),
        inputTokens: totalInputTokens,
        outputTokens,
      });
    },
  };
}
