/**
 * write — file create / overwrite.
 *
 * Workspace boundary enforced via fd-based open with O_NOFOLLOW (see safe-path.ts).
 * The kernel refuses to follow a symlink at the final component, eliminating the
 * "swap target between resolve and write" attack.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, ToolResult } from '@nexora/contracts';
import { textResult, errorResult } from '@nexora/contracts';
import {
  openForWrite,
  PathOutsideWorkspaceError,
  SymlinkRefusedError,
} from './safe-path.js';

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

      // mkdir -p the parent directory.
      // We deliberately do NOT canonicalize the parent here — openForWrite will
      // re-validate after creation, and the actual safety guarantee comes from
      // O_NOFOLLOW on the final open.
      const parent = path.dirname(path.isAbsolute(rawPath)
        ? rawPath
        : path.join(ctx.workdir, rawPath));
      try {
        await fsp.mkdir(parent, { recursive: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot create parent dir: ${msg}`);
      }

      let handle: fsp.FileHandle;
      try {
        handle = await openForWrite(rawPath, ctx.workdir);
      } catch (err) {
        if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
        if (err instanceof SymlinkRefusedError) return errorResult(err.message);
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot open for write: ${msg}`);
      }

      try {
        await handle.writeFile(params.content, 'utf-8');
        ctx.logger.info('write', { path: rawPath, bytes: params.content.length });
        return textResult(`Wrote ${params.content.length} bytes to ${rawPath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot write: ${msg}`);
      } finally {
        await handle.close().catch(() => {});
      }
    },
  };
}
