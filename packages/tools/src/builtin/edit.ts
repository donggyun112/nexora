/**
 * edit — replace a substring in an existing file.
 *
 * Backend-agnostic: the read-modify-write goes through the workspace filesystem
 * runtime (`WorkspaceFs`). Atomicity (temp+rename), no-follow opens, and
 * permission-bit preservation live in the runtime implementation — locally in
 * `LocalWorkspaceFs`, server-side for a remote backend — so this tool carries no
 * local-vs-remote branching.
 */

import path from 'node:path';
import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';
import { PathOutsideWorkspaceError, SymlinkRefusedError } from './safe-path.js';
import { workspaceFs } from './workspace-access.js';

export function createEditTool(): ToolDefinition {
  return {
    name: 'edit',
    description:
      'Replace a string in an existing file. By default replaces a single occurrence — ' +
      'old_string must be unique. Set replace_all to replace every occurrence. ' +
      'For new files use the write tool instead. Changes are written atomically.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute or relative to workdir)' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    execute: async (_id, input, ctx): Promise<ToolResult> => {
      const params = input as {
        path?: string;
        old_string?: string;
        new_string?: string;
        replace_all?: boolean;
      };

      const rawPath = (params.path ?? '').trim();
      if (!rawPath) return errorResult('path is required');
      if (typeof params.old_string !== 'string') return errorResult('old_string is required');
      if (typeof params.new_string !== 'string') return errorResult('new_string is required');
      if (params.old_string === params.new_string) {
        return errorResult('old_string and new_string are identical');
      }
      const oldString: string = params.old_string;
      const newString: string = params.new_string;
      const replaceAll = params.replace_all === true;

      const { fs, root } = workspaceFs(ctx);

      // Serialize the read-modify-write per (root, path): atomic replace prevents
      // torn reads but not lost updates, so concurrent children sharing
      // ctx.resourceLock must run one-at-a-time per file.
      const applyEdit = async (): Promise<ToolResult> => {
        let content: string;
        let mode: number | undefined;
        try {
          const st = await fs.stat(rawPath);
          if (st.isDirectory) return errorResult(`Cannot edit: ${rawPath} is a directory`);
          mode = st.mode; // preserve permission bits across the rewrite
          content = Buffer.from(await fs.readFile(rawPath)).toString('utf-8');
        } catch (err) {
          if (err instanceof PathOutsideWorkspaceError || err instanceof SymlinkRefusedError) {
            return errorResult(err.message);
          }
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return errorResult(`Cannot edit: ${rawPath} not found`);
          }
          return errorResult(`Cannot edit: ${err instanceof Error ? err.message : String(err)}`);
        }

        let updated: string;
        let summary: string;
        if (replaceAll) {
          if (!content.includes(oldString)) return errorResult('old_string not found in file');
          updated = content.split(oldString).join(newString);
          const replacedBytes = content.length - updated.length;
          const replacedCount = oldString.length === newString.length
            ? content.split(oldString).length - 1
            : Math.abs(Math.round(replacedBytes / (oldString.length - newString.length || 1)));
          summary = `Replaced all occurrences in ${rawPath} (~${replacedCount} replacements)`;
        } else {
          const occurrences = content.split(oldString).length - 1;
          if (occurrences === 0) return errorResult('old_string not found in file');
          if (occurrences > 1) {
            return errorResult(
              `old_string appears ${occurrences} times — provide more context to make it unique, or set replace_all`,
            );
          }
          updated = content.replace(oldString, newString);
          summary = `Replaced 1 occurrence in ${rawPath}`;
        }

        try {
          await fs.writeFile(rawPath, Buffer.from(updated, 'utf-8'), { mode, atomic: true });
        } catch (err) {
          if (err instanceof PathOutsideWorkspaceError || err instanceof SymlinkRefusedError) {
            return errorResult(err.message);
          }
          return errorResult(`Cannot edit: ${err instanceof Error ? err.message : String(err)}`);
        }

        ctx.logger.info('edit', { path: rawPath });
        return textResult(summary);
      };

      const lockKey = path.resolve(root, rawPath);
      return ctx.resourceLock
        ? ctx.resourceLock.runExclusive(lockKey, applyEdit)
        : applyEdit();
    },
  };
}
