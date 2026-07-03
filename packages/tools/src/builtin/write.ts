/**
 * write — file create / overwrite.
 *
 * The tool is backend-agnostic: it writes through the workspace filesystem
 * runtime (`WorkspaceFs`) and never touches the host fs or the wire directly, so
 * local, OS-sandboxed, and remote workspaces differ only by which runtime is
 * active. The runtime enforces the jail and no-follow write (locally via
 * O_NOFOLLOW; remotely server-side).
 */

import path from 'node:path';
import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';
import { PathOutsideWorkspaceError, SymlinkRefusedError } from './safe-path.js';
import { workspaceFs } from './workspace-access.js';

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
      const content: string = params.content;

      const { fs, root } = workspaceFs(ctx);

      const doWrite = async (): Promise<ToolResult> => {
        try {
          await fs.writeFile(rawPath, Buffer.from(content, 'utf-8'), { atomic: false });
          ctx.logger.info('write', { path: rawPath, bytes: content.length });
          return textResult(`Wrote ${content.length} bytes to ${rawPath}`);
        } catch (err) {
          if (err instanceof PathOutsideWorkspaceError || err instanceof SymlinkRefusedError) {
            return errorResult(err.message);
          }
          return errorResult(`Cannot write: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      // Serialize writes per resolved file path so concurrent children sharing
      // ctx.resourceLock don't interleave on the same file (and order against edit).
      const lockKey = path.resolve(root, rawPath);
      return ctx.resourceLock
        ? ctx.resourceLock.runExclusive(lockKey, doWrite)
        : doWrite();
    },
  };
}
