/**
 * todo — session-scoped task tracking (hermes TodoStore pattern).
 *
 * The agent uses this tool to manage a task list within a session.
 * After context compression, the active tasks are re-injected so the
 * agent doesn't lose track of what it was doing.
 */

import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'done';
}

/**
 * Session-scoped todo store. One per agent execution.
 * Designed to survive context compression via formatForInjection().
 */
export class TodoStore {
  private items: TodoItem[] = [];
  private nextId = 1;

  add(content: string): TodoItem {
    const item: TodoItem = { id: String(this.nextId++), content, status: 'pending' };
    this.items.push(item);
    return item;
  }

  update(id: string, fields: Partial<Pick<TodoItem, 'content' | 'status'>>): TodoItem | null {
    const item = this.items.find(i => i.id === id);
    if (!item) return null;
    if (fields.content !== undefined) item.content = fields.content;
    if (fields.status !== undefined) item.status = fields.status;
    return item;
  }

  remove(id: string): boolean {
    const len = this.items.length;
    this.items = this.items.filter(i => i.id !== id);
    return this.items.length < len;
  }

  list(): readonly TodoItem[] {
    return this.items;
  }

  /**
   * Format active tasks for injection after context compression.
   * Only includes pending/in_progress — completed tasks are omitted
   * to prevent the agent from re-doing finished work.
   */
  formatForInjection(): string | null {
    const active = this.items.filter(i => i.status !== 'done');
    if (active.length === 0) return null;
    const lines = ['[Active tasks preserved across context compression]'];
    for (const item of active) {
      const marker = item.status === 'in_progress' ? '→' : '○';
      lines.push(`${marker} ${item.id}. ${item.content} (${item.status})`);
    }
    return lines.join('\n');
  }
}

interface TodoParams {
  action: 'add' | 'update' | 'remove' | 'list';
  content?: string;
  id?: string;
  status?: 'pending' | 'in_progress' | 'done';
}

export function createTodoTool(store: TodoStore): ToolDefinition {
  return {
    name: 'todo',
    description:
      'Manage a task list for the current session. Use to track progress on multi-step work. ' +
      'Tasks survive context compression.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'update', 'remove', 'list'],
          description: 'Action to perform',
        },
        content: { type: 'string', description: 'Task content (for add/update)' },
        id: { type: 'string', description: 'Task ID (for update/remove)' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done'],
          description: 'New status (for update)',
        },
      },
      required: ['action'],
    },
    isReadOnly: (input) => (input as TodoParams)?.action === 'list',
    isConcurrencySafe: false,
    execute: async (_callId, rawInput): Promise<ToolResult> => {
      const p = rawInput as TodoParams;

      switch (p.action) {
        case 'add': {
          if (!p.content) return errorResult('content is required for add');
          const item = store.add(p.content);
          return textResult(`Added task #${item.id}: ${item.content}`);
        }
        case 'update': {
          if (!p.id) return errorResult('id is required for update');
          const updated = store.update(p.id, { content: p.content, status: p.status });
          if (!updated) return errorResult(`Task #${p.id} not found`);
          return textResult(`Updated task #${updated.id}: ${updated.content} (${updated.status})`);
        }
        case 'remove': {
          if (!p.id) return errorResult('id is required for remove');
          return store.remove(p.id)
            ? textResult(`Removed task #${p.id}`)
            : errorResult(`Task #${p.id} not found`);
        }
        case 'list': {
          const items = store.list();
          if (items.length === 0) return textResult('No tasks.');
          return textResult(items.map(i => `#${i.id} [${i.status}] ${i.content}`).join('\n'));
        }
        default:
          return errorResult(`Unknown action: ${p.action}`);
      }
    },
  };
}
