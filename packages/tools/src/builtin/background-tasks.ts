/**
 * Background-task control tools.
 *
 * Tool-neutral: any tool may launch a background task and register it in the
 * shared BackgroundTaskRegistry (on ToolContext). These tools let the parent
 * agent observe (`check_tasks`) and cancel (`cancel_task`) those tasks. The
 * registry type + in-memory impl live in @dongkseo/contracts.
 */

import type { BackgroundTaskRegistry, BackgroundTaskStatus, ToolContext, ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';

export interface TaskControlToolOptions {
  registry: BackgroundTaskRegistry;
}

/**
 * `check_tasks` — list the background tasks this agent launched, with their
 * status. Lets the agent decide whether to wait, proceed, or cancel.
 */
export function createCheckTasksTool(options: TaskControlToolOptions): ToolDefinition {
  return {
    name: 'check_tasks',
    description:
      'List background tasks you launched and their status ' +
      '(running / done / error / cancelled).',
    parameters: { type: 'object', properties: {} } as unknown as Record<string, unknown>,
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    async execute(_callId: string, _rawInput: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const tasks = options.registry.list();
      if (tasks.length === 0) return textResult('No background tasks.');
      return textResult(JSON.stringify(tasks));
    },
  };
}

/**
 * `cancel_task` — abort a running background task by id. The parent holds this
 * leash; cancelling invokes the task's registered abort handle.
 */
export function createCancelTasksTool(options: TaskControlToolOptions): ToolDefinition {
  return {
    name: 'cancel_task',
    description: 'Abort a running background task by its id (from check_tasks).',
    parameters: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', description: 'Task id returned when the task was launched.' },
      },
    } as unknown as Record<string, unknown>,
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: true,
    async execute(_callId: string, rawInput: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const taskId = (rawInput as { task_id?: unknown })?.task_id;
      if (typeof taskId !== 'string' || !taskId.trim()) {
        return errorResult('task_id is required');
      }
      const ok = options.registry.cancel(taskId.trim());
      return ok
        ? textResult(`Cancelled task ${taskId.trim()}.`)
        : errorResult(`No running task with id ${taskId.trim()}.`);
    },
  };
}

/**
 * `watch_task` — arm a non-blocking, one-shot trigger on background tasks.
 * When the watched tasks settle (mode 'all' or 'any'), a status message is
 * folded into the agent's turn via steerSelf, or delivered as a follow-up via
 * deliverResult. Rides the ToolContext primitives the runtime injects.
 */
export function createWatchTaskTool(): ToolDefinition {
  return {
    name: 'watch_task',
    description:
      'Get notified (non-blocking) when background tasks settle. Provide task_ids ' +
      'and optionally mode ("all" — default — or "any"). Returns immediately; you ' +
      'are notified with each task\'s final status (done/error/cancelled) when the ' +
      'condition is met. Use task ids from check_tasks / a launched task.',
    parameters: {
      type: 'object',
      required: ['task_ids'],
      properties: {
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Background task ids to watch.' },
        mode: { type: 'string', enum: ['all', 'any'], description: 'Fire when all (default) or any of the tasks settle.' },
        message: { type: 'string', description: 'Optional note included in the notification.' },
      },
    } as unknown as Record<string, unknown>,
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    async execute(_callId: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
      const registry: BackgroundTaskRegistry | undefined = ctx.backgroundTasks;
      if (!registry) return errorResult('Background tasks are not supported in this runtime.');

      const input = rawInput as { task_ids?: unknown; mode?: unknown; message?: unknown };
      const taskIds = Array.isArray(input.task_ids)
        ? input.task_ids.filter((x): x is string => typeof x === 'string')
        : [];
      if (taskIds.length === 0) return errorResult('task_ids must be a non-empty array of task ids.');
      const mode: 'all' | 'any' = input.mode === 'any' ? 'any' : 'all';
      const note = typeof input.message === 'string' ? input.message : '';

      const unknownIds = taskIds.filter((id) => !registry.get(id));
      if (unknownIds.length > 0) {
        return errorResult(`Unknown task id(s): ${unknownIds.join(', ')}. Nothing to watch.`);
      }

      const statusOf = (id: string): BackgroundTaskStatus | 'gone' => registry.get(id)?.status ?? 'gone';
      const isTerminal = (id: string) => {
        const s = statusOf(id);
        return s !== 'running' && s !== 'gone';
      };
      const satisfied = () => (mode === 'all' ? taskIds.every(isTerminal) : taskIds.some(isTerminal));

      const fire = () => {
        const statuses = taskIds.map((id) => `${id}=${statusOf(id)}`).join(', ');
        const anyError = taskIds.some((id) => statusOf(id) === 'error');
        const msg = `[watch] tasks settled (mode=${mode}): ${statuses}.${note ? ' ' + note : ''}`;
        if (ctx.steerSelf?.(msg)) return;
        if (ctx.deliverResult) {
          void ctx.deliverResult({ taskId: `watch:${taskIds.join(',')}`, kind: 'watch', label: 'watch', content: msg, isError: anyError });
          return;
        }
        ctx.logger.warn('watch_task.notify_dropped', { taskIds, reason: 'no steerSelf and no deliverResult' });
      };

      if (satisfied()) {
        fire();
        return textResult(`Watched ${taskIds.length} task(s) — already settled; notified now.`);
      }

      const unsubscribe = registry.subscribe(() => {
        if (satisfied()) {
          unsubscribe();
          fire();
        }
      });
      return textResult(`Watching ${taskIds.length} task(s) (mode=${mode}); you'll be notified when they settle.`);
    },
  };
}
