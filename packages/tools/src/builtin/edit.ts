/**
 * edit — replace a substring in an existing file.
 *
 * Strategy: read original → compute updated → write to a sibling temp file →
 * atomic rename temp over original. This is the standard atomic-replace pattern:
 *
 *   - If any step fails, the original file is untouched (we only rename on success).
 *   - Readers see either the old content or the new content, never a half-written file.
 *   - rename(2) on POSIX operates on the path, not following symlinks at the
 *     target, so even if an attacker swaps the target to a symlink between
 *     read and rename, the symlink is OVERWRITTEN rather than traversed.
 *
 * Previous versions used `handle.truncate(0) + handle.write(str, 0)` which is
 * neither atomic (readers can see an empty file mid-write) nor guaranteed to
 * write the full payload (Node's write may short-write).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';
import {
  openForRead,
  openForWrite,
  canonicalizePath,
  PathOutsideWorkspaceError,
  SymlinkRefusedError,
} from './safe-path.js';
import { resolveToolPath, type ToolPathResolution } from './workspace-access.js';

export function createEditTool(): ToolDefinition {
  return {
    name: 'edit',
    description:
      'Replace a string in an existing file. By default replaces a single occurrence — ' +
      'old_string must be unique. Set replace_all to replace every occurrence. ' +
      'For new files use the write tool instead. Changes are written atomically ' +
      '(temp file + rename).',
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
      // Capture the validated strings as consts so the narrowing survives into
      // the applyEdit closure below (TS drops param narrowing across the nested fn).
      const oldString: string = params.old_string;
      const newString: string = params.new_string;
      let target;
      try {
        target = await resolveToolPath(ctx, rawPath, 'readwrite');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(msg);
      }
      const workdir = target.root;
      const targetPath = target.path;

      // Serialize the whole read-modify-write per file path. Atomic rename
      // prevents torn reads but NOT lost updates, so concurrent children sharing
      // ctx.resourceLock must run this section one-at-a-time per file. No lock
      // (single agent) → runExclusive is bypassed at the dispatch below.
      const applyEdit = async (): Promise<ToolResult> => {
      // Step 1: read the original atomically (fd with O_NOFOLLOW) and capture
      // its permission bits. The temp file we write to below is created with
      // a default 0o644 mode by openForWrite — without preserving the original
      // mode, a 0o600 secrets file would leak as world-readable after rename,
      // and a 0o755 script would lose its executable bit.
      let content: string;
      let originalMode: number;
      try {
        const readHandle = await openForRead(targetPath, workdir);
        try {
          const stat = await readHandle.stat();
          // Only keep the 12 mode bits that matter for file permissions
          // (setuid/setgid/sticky + rwx for ugo). Higher bits are file-type.
          originalMode = stat.mode & 0o7777;
          content = await readHandle.readFile('utf-8');
        } finally {
          await readHandle.close().catch(() => {});
        }
      } catch (err) {
        if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
        if (err instanceof SymlinkRefusedError) return errorResult(err.message);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return errorResult(`Cannot edit: ${rawPath} not found`);
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot edit: ${msg}`);
      }

      // Step 2: compute updated content.
      let updated: string;
      let summary: string;

      if (params.replace_all) {
        if (!content.includes(oldString)) {
          return errorResult('old_string not found in file');
        }
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

      // Step 3: write updated content to a SIBLING temp file (same directory,
      // so rename is atomic on the same filesystem).
      const tempSuffix = randomBytes(6).toString('hex');
      const targetBasename = path.basename(targetPath);
      const targetDir = path.dirname(targetPath);
      const tempPath = path.join(targetDir, `.${targetBasename}.nexora-${tempSuffix}.tmp`);

      let writeHandle;
      let temp: ToolPathResolution | undefined;
      try {
        temp = await resolveToolPath(ctx, tempPath, 'write');
        writeHandle = await openForWrite(temp.path, temp.root);
      } catch (err) {
        if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
        if (err instanceof SymlinkRefusedError) return errorResult(err.message);
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot create temp file: ${msg}`);
      }

      try {
        // handle.writeFile loops internally until every byte is written — avoids
        // the short-write bug of a single handle.write().
        await writeHandle.writeFile(updated, 'utf-8');
        // Preserve the original file's permission bits BEFORE rename so that
        // a 0o600 secrets file stays 0o600 and a 0o755 script stays executable.
        // Round-4 review flagged that without this, rename would clobber
        // permissions back to openForWrite's default 0o644.
        await writeHandle.chmod(originalMode);
        // Flush to disk before rename so the new file is durable even if the
        // process crashes during the rename().
        await writeHandle.sync().catch(() => {});
      } catch (err) {
        await writeHandle.close().catch(() => {});
        // Clean up the temp file so we don't leave garbage.
        await cleanupTemp(temp?.path ?? tempPath, workdir);
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot write temp file: ${msg}`);
      }
      await writeHandle.close().catch(() => {});

      // Step 4: atomic rename temp → target. Both paths are pre-validated to
      // be inside the workspace. rename(2) is atomic on POSIX.
      let finalTempPath: string;
      let finalTargetPath: string;
      try {
        finalTempPath = await canonicalizePath(temp?.path ?? tempPath, workdir);
        finalTargetPath = await canonicalizePath(targetPath, workdir);
      } catch (err) {
        await cleanupTemp(temp?.path ?? tempPath, workdir);
        if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot canonicalize: ${msg}`);
      }

      try {
        await fsp.rename(finalTempPath, finalTargetPath);
      } catch (err) {
        await cleanupTemp(temp?.path ?? tempPath, workdir);
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot atomically replace: ${msg}`);
      }

      ctx.logger.info('edit', { path: rawPath });
      return textResult(summary);
      };

      // Key on the absolute path so different spellings of the same file share
      // one lock (resolveToolPath may return a workdir-relative path).
      const lockKey = path.resolve(workdir, targetPath);
      return ctx.resourceLock
        ? ctx.resourceLock.runExclusive(lockKey, applyEdit)
        : applyEdit();
    },
  };
}

async function cleanupTemp(tempPath: string, workdir: string): Promise<void> {
  try {
    const canonical = await canonicalizePath(tempPath, workdir);
    await fsp.unlink(canonical).catch(() => {});
  } catch {
    // best-effort — temp might not exist or be outside workspace
  }
}
