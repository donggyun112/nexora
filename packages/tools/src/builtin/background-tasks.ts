/**
 * Background-task control tools.
 *
 * Tool-neutral: any tool may launch a background task and register it in the
 * shared BackgroundTaskRegistry (on ToolContext). These tools let the parent
 * agent observe (`check_tasks`) and cancel (`cancel_task`) those tasks. The
 * registry type + in-memory impl live in @dongkseo/contracts.
 */

import type { BackgroundTaskRegistry, ToolContext, ToolDefinition, ToolResult } from '@dongkseo/contracts';
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
