/**
 * read — file/directory reader.
 *
 * Workspace boundary is enforced via fd-based opens with O_NOFOLLOW (see
 * safe-path.ts). Symlinks at the final path component are refused at the
 * kernel level, eliminating the TOCTOU window between resolve() and read().
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';
import {
  openForRead,
  resolveDirForListing,
  PathOutsideWorkspaceError,
  SymlinkRefusedError,
} from './safe-path.js';
import { resolveToolPath } from './workspace-access.js';

const MAX_LINES = 2000;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB hard cap

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function createReadTool(): ToolDefinition {
  return {
    name: 'read',
    description:
      'Read a file from the workspace. By default reads up to 2000 lines from the start. ' +
      'Use offset (1-based) and limit to page through large files. ' +
      'If a directory path is given, lists its contents instead. ' +
      'Results include line numbers prefixed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute or relative to workdir)' },
        offset: { type: 'number', description: '1-based line number to start from' },
        limit: { type: 'number', description: 'Maximum number of lines to return' },
      },
      required: ['path'],
    },
    execute: async (_id, input, ctx): Promise<ToolResult> => {
      const params = input as { path?: string; offset?: number; limit?: number };
      const rawPath = (params.path ?? '').trim();
      if (!rawPath) return errorResult('path is required');

      // Try to open as a file first. If the path is a directory, openForRead
      // returns EISDIR — we then fall back to the directory-listing path.
      let resolved;
      try {
        resolved = await resolveToolPath(ctx, rawPath, 'read');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(msg);
      }
      const workdir = resolved.root;
      const toolPath = resolved.path;
      let handle: fsp.FileHandle | null = null;
      try {
        handle = await openForRead(toolPath, workdir);
      } catch (err) {
        if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
        if (err instanceof SymlinkRefusedError) return errorResult(err.message);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return errorResult(`Cannot read: ${rawPath} not found`);
        if (code === 'EISDIR') {
          return readDirectory(toolPath, workdir);
        }
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot read: ${msg}`);
      }

      try {
        const stat = await handle.stat();
        if (stat.isDirectory()) {
          // Some platforms let us open() a directory successfully. Redirect to listing.
          await handle.close().catch(() => {});
          handle = null;
          return readDirectory(toolPath, workdir);
        }
        if (!stat.isFile()) {
          return errorResult(`Cannot read: ${rawPath} is not a regular file`);
        }
        if (stat.size > MAX_BYTES) {
          return errorResult(`Cannot read: ${rawPath} exceeds ${MAX_BYTES} byte cap (${stat.size} bytes)`);
        }

        const imageMime = IMAGE_MIME_BY_EXT[path.extname(toolPath).toLowerCase()];
        if (imageMime) {
          const bytes = await handle.readFile();
          return { type: 'image', data: bytes.toString('base64'), mimeType: imageMime };
        }

        const content = (await handle.readFile('utf-8'));
        const allLines = content.split('\n');
        const totalLines = allLines.length;

        const start = params.offset && params.offset > 0 ? params.offset - 1 : 0;
        const count = params.limit && params.limit > 0
          ? Math.min(params.limit, MAX_LINES)
          : MAX_LINES;
        const end = Math.min(start + count, totalLines);

        const numbered = allLines
          .slice(start, end)
          .map((line, i) => `${String(start + i + 1).padStart(6)}\u2192${line}`)
          .join('\n');

        let text = numbered;
        if (end < totalLines) {
          text += `\n\n[Showing lines ${start + 1}-${end} of ${totalLines}. Use offset=${end + 1} to continue.]`;
        }
        return textResult(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot read: ${msg}`);
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
    },
  };
}

async function readDirectory(rawPath: string, workdir: string): Promise<ToolResult> {
  let dirPath: string;
  try {
    dirPath = await resolveDirForListing(rawPath, workdir);
  } catch (err) {
    if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`Cannot read: ${msg}`);
  }
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const lines = entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    return textResult(`Directory: ${dirPath}\n\n${lines.join('\n')}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`Cannot read: ${msg}`);
  }
}
