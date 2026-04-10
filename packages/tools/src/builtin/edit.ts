/**
 * edit — replace a substring in an existing file.
 *
 * Uses fd-based RDWR with O_NOFOLLOW (see safe-path.ts) so the read and the
 * subsequent write happen via the same kernel handle. The path-resolve →
 * fs.readFile → fs.writeFile pattern from the previous version had a TOCTOU
 * window where an attacker could swap the target between the read and the write.
 */

import type { ToolDefinition, ToolResult } from '@nexora/contracts';
import { textResult, errorResult } from '@nexora/contracts';
import {
  openForReadWrite,
  PathOutsideWorkspaceError,
  SymlinkRefusedError,
} from './safe-path.js';

export function createEditTool(): ToolDefinition {
  return {
    name: 'edit',
    description:
      'Replace a string in an existing file. By default replaces a single occurrence — ' +
      'old_string must be unique. Set replace_all to replace every occurrence. ' +
      'For new files use the write tool instead.',
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

      let handle;
      try {
        handle = await openForReadWrite(rawPath, ctx.workdir);
      } catch (err) {
        if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
        if (err instanceof SymlinkRefusedError) return errorResult(err.message);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return errorResult(`Cannot edit: ${rawPath} not found`);
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot edit: ${msg}`);
      }

      try {
        const content = await handle.readFile('utf-8');

        let updated: string;
        let summary: string;

        if (params.replace_all) {
          if (!content.includes(params.old_string)) {
            return errorResult('old_string not found in file');
          }
          updated = content.split(params.old_string).join(params.new_string);
          const replacedBytes = content.length - updated.length;
          const replacedCount = params.old_string.length === params.new_string.length
            ? content.split(params.old_string).length - 1
            : Math.abs(Math.round(replacedBytes / (params.old_string.length - params.new_string.length || 1)));
          summary = `Replaced all occurrences in ${rawPath} (~${replacedCount} replacements)`;
        } else {
          const occurrences = content.split(params.old_string).length - 1;
          if (occurrences === 0) return errorResult('old_string not found in file');
          if (occurrences > 1) {
            return errorResult(
              `old_string appears ${occurrences} times — provide more context to make it unique, or set replace_all`,
            );
          }
          updated = content.replace(params.old_string, params.new_string);
          summary = `Replaced 1 occurrence in ${rawPath}`;
        }

        // Truncate + rewrite via the same fd. This is the atomic pair that
        // closes the TOCTOU hole — there is no path lookup between read and write.
        await handle.truncate(0);
        await handle.write(updated, 0, 'utf-8');
        ctx.logger.info('edit', { path: rawPath });
        return textResult(summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot edit: ${msg}`);
      } finally {
        await handle.close().catch(() => {});
      }
    },
  };
}
