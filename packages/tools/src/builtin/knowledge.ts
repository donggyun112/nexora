/**
 * knowledge — 지식 베이스 도구.
 *
 * KnowledgeStore에 위임 — list/read/write/append/delete.
 * 네임스페이스는 ToolContext.scope.namespace가 있으면 이를 우선 사용하고,
 * 구버전 호출자는 ToolContext.tenantId로 폴백한다.
 *
 * 참고: knowledge.tool.ts (auto-work-flow)
 */

import type { ToolDefinition, ToolResult, KnowledgeStore } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';

export function createKnowledgeTool(store: KnowledgeStore): ToolDefinition {
  return {
    name: 'knowledge',
    description:
      'Persistent shared knowledge base for operational rules, domain facts, and team conventions. ' +
      'Use this to remember information across conversations. ' +
      'Actions: "list", "read", "write" (overwrite), "append", "delete".',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'write', 'append', 'delete'],
          description: 'Operation to perform',
        },
        topic: { type: 'string', description: 'Topic name (e.g. "operational-rules")' },
        content: { type: 'string', description: 'Markdown content for write/append' },
      },
      required: ['action'],
    },
    execute: async (_id, input, ctx): Promise<ToolResult> => {
      const { action, topic, content } = input as {
        action: string;
        topic?: string;
        content?: string;
      };

      const namespace = ctx.scope?.namespace ?? ctx.tenantId;

      try {
        switch (action) {
          case 'list': {
            const topics = await store.list(namespace);
            if (topics.length === 0) return textResult('No knowledge topics yet.');
            const lines = topics.map(t => `- ${t.name}: ${t.title} (${t.lineCount} lines)`);
            return textResult(`Knowledge topics (${topics.length}):\n${lines.join('\n')}`);
          }

          case 'read': {
            if (!topic) return errorResult('topic is required for "read"');
            const text = await store.read(namespace, topic);
            if (text === null) return textResult(`Topic "${topic}" not found.`);
            return textResult(text);
          }

          case 'write': {
            if (!topic) return errorResult('topic is required for "write"');
            if (typeof content !== 'string') return errorResult('content is required for "write"');
            await store.write(namespace, topic, content);
            return textResult(`Written: ${topic}`);
          }

          case 'append': {
            if (!topic) return errorResult('topic is required for "append"');
            if (typeof content !== 'string') return errorResult('content is required for "append"');
            await store.append(namespace, topic, content);
            return textResult(`Appended to: ${topic}`);
          }

          case 'delete': {
            if (!topic) return errorResult('topic is required for "delete"');
            await store.delete(namespace, topic);
            return textResult(`Deleted: ${topic}`);
          }

          default:
            return errorResult(`Unknown action "${action}". Use list, read, write, append, delete.`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`knowledge.${action} failed: ${msg}`);
      }
    },
  };
}
