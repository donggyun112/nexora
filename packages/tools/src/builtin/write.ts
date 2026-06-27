/**
 * write — file create / overwrite.
 *
 * Workspace boundary enforced via fd-based open with O_NOFOLLOW (see safe-path.ts).
 * The kernel refuses to follow a symlink at the final component, eliminating the
 * "swap target between resolve and write" attack.
 *
 * mkdir-p for parent directories now happens INSIDE openForWrite, AFTER path
 * canonicalization, so a malicious `../outside/file` cannot create directories
 * on the host before the workspace check runs.
 */

import path from 'node:path';
import type fsp from 'node:fs/promises';
import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';
import {
  openForWrite,
  PathOutsideWorkspaceError,
  SymlinkRefusedError,
} from './safe-path.js';
import { resolveToolPath } from './workspace-access.js';

export function createWriteTool(): ToolDefinition {
  return {
    name: 'write',
    description:
      'Create or overwrite a file in the workspace. ' +
      'Parent directories are created automatically. ' +
      'Use this for new files; use edit for changing existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute or relative to workdir)' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
    },
    execute: async (_id, input, ctx): Promise<ToolResult> => {
      const params = input as { path?: string; content?: string };
      const rawPath = (params.path ?? '').trim();
      if (!rawPath) return errorResult('path is required');
      if (typeof params.content !== 'string') return errorResult('content is required');
      // Capture so the narrowing survives into the doWrite closure below.
      const content: string = params.content;

      let resolved;
      try {
        resolved = await resolveToolPath(ctx, rawPath, 'write');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(msg);
      }

      const doWrite = async (): Promise<ToolResult> => {
        let handle: fsp.FileHandle;
        try {
          // openForWrite does the parent mkdir AFTER canonicalization — safe.
          handle = await openForWrite(resolved.path, resolved.root);
        } catch (err) {
          if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
          if (err instanceof SymlinkRefusedError) return errorResult(err.message);
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult(`Cannot open for write: ${msg}`);
        }

        try {
          await handle.writeFile(content, 'utf-8');
          ctx.logger.info('write', { path: rawPath, bytes: content.length });
          return textResult(`Wrote ${content.length} bytes to ${rawPath}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult(`Cannot write: ${msg}`);
        } finally {
          await handle.close().catch(() => {});
        }
      };

      // Serialize writes per absolute path so concurrent children sharing
      // ctx.resourceLock don't interleave on the same file (and order against
      // edit, which keys the same way). No lock → run directly.
      const lockKey = path.resolve(resolved.root, resolved.path);
      return ctx.resourceLock
        ? ctx.resourceLock.runExclusive(lockKey, doWrite)
        : doWrite();
    },
  };
}
