/**
 * grep — 패턴 검색 도구.
 *
 * 시스템 grep을 호출 (-rEn). workdir 기준.
 * include 글롭으로 파일 필터, context 옵션.
 */

import { execFile, type ExecFileException } from 'node:child_process';
import path from 'node:path';
import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';
import { canonicalizePath, PathOutsideWorkspaceError, resolveDirForListing } from './safe-path.js';
import { buildToolEnv } from './tool-env.js';
import { resolveToolPath } from './workspace-access.js';

const MAX_LINES = 200;
const GREP_TIMEOUT_MS = 120_000;
const GREP_MAX_BUFFER = 4 * 1024 * 1024;

export function createGrepTool(): ToolDefinition {
  const env = buildToolEnv();

  return {
    name: 'grep',
    description:
      'Search for a regex pattern across files in the workspace using extended regex. ' +
      'Returns file:line:match. Use path to narrow to a subdirectory. ' +
      'Use include to restrict by filename glob (e.g. "*.ts"). ' +
      'Returns "No matches found." when nothing matches (not an error).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Extended regex (e.g. "TODO|FIXME")' },
        path: { type: 'string', description: '(Optional) subdirectory relative to workspace' },
        include: { type: 'string', description: '(Optional) filename glob (e.g. "*.ts")' },
        context: { type: 'number', description: '(Optional) lines of context (0-10)' },
      },
      required: ['pattern'],
    },
    execute: async (_id, input, ctx): Promise<ToolResult> => {
      const params = input as {
        pattern?: string;
        path?: string;
        include?: string;
        context?: number;
      };

      const pattern = (params.pattern ?? '').trim();
      if (!pattern) return errorResult('pattern is required');

      const subpath = params.path?.trim();
      let resolved;
      try {
        resolved = await resolveToolPath(ctx, subpath || '.', 'list');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(msg);
      }
      const root = path.resolve(resolved.root);
      const searchPath = toWorkspaceRelativeInput(resolved.path, root);
      let grepPath: string;
      let realRoot: string;
      try {
        const canonicalSearchPath = await canonicalizePath(searchPath, root);
        realRoot = await resolveDirForListing('.', root);
        grepPath = await resolveDirForListing(canonicalSearchPath, root);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return textResult('No matches found.');
        if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot grep: ${msg}`);
      }
      const stripRoots = uniqueRoots([realRoot, root]);

      const include = params.include?.trim();
      if (include && (include.includes('/') || include.includes('..'))) {
        return errorResult('include must not contain "/" or ".."');
      }

      const ctxLines = params.context !== undefined
        ? Math.max(0, Math.min(10, Math.trunc(params.context)))
        : 0;

      const args = ['-rEn', '--color=never'];
      if (include) args.push(`--include=${include}`);
      if (ctxLines > 0) args.push(`-C${ctxLines}`);
      args.push('--', pattern, grepPath);

      let grepResult: GrepProcessResult;
      if (ctx.workspace?.run) {
        const result = await ctx.workspace.run({
          argv: ['grep', ...args],
          cwd: root,
          env,
          signal: ctx.signal,
          timeoutMs: GREP_TIMEOUT_MS,
        });
        grepResult = {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          aborted: result.aborted,
        };
      } else {
        let timedOut = false;
        let parentAbortRequested = false;
        let localSettled = false;
        const controller = new AbortController();
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, GREP_TIMEOUT_MS);
        timer.unref?.();
        const onParentAbort = (): void => {
          if (localSettled) return;
          parentAbortRequested = true;
          controller.abort();
        };
        if (ctx.signal?.aborted) onParentAbort();
        else ctx.signal?.addEventListener('abort', onParentAbort, { once: true });

        const local = await new Promise<{ stdout: string; error?: ExecFileException }>((resolve) => {
          execFile('grep', args, {
            env,
            maxBuffer: GREP_MAX_BUFFER,
            signal: controller.signal,
          }, (err, out) => {
            localSettled = true;
            resolve({ stdout: out, error: err ?? undefined });
          });
        });
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onParentAbort);
        grepResult = normalizeLocalGrepResult(local.stdout, local.error, timedOut, parentAbortRequested);
      }

      const classified = classifyGrepResult(grepResult);
      if (classified.type === 'error') return errorResult(classified.message);
      const { stdout, warning } = classified;
      if (!stdout.trim()) return textResult('No matches found.');

      const lines = stdout
        .trimEnd()
        .split('\n')
        .map(line => stripWorkspacePrefix(line, stripRoots));

      if (lines.length > MAX_LINES) {
        return textResult(
          lines.slice(0, MAX_LINES).join('\n') +
          `\n\n[Truncated: showing ${MAX_LINES} of ${lines.length} lines]` +
          warning,
        );
      }

      return textResult(lines.join('\n') + warning);
    },
  };
}

function uniqueRoots(roots: string[]): string[] {
  return [...new Set(roots)].sort((a, b) => b.length - a.length);
}

function toWorkspaceRelativeInput(rawPath: string, root: string): string {
  if (!path.isAbsolute(rawPath)) return rawPath;
  const absolutePath = path.resolve(rawPath);
  if (absolutePath === root) return '.';
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolutePath.startsWith(rootPrefix)) return path.relative(root, absolutePath) || '.';
  return rawPath;
}

function stripWorkspacePrefix(line: string, roots: string[]): string {
  for (const root of roots) {
    if (line.startsWith(root + path.sep)) return line.slice(root.length + 1);
    if (line.startsWith(`${root}:`)) return `.${line.slice(root.length)}`;
  }
  return line;
}

interface GrepProcessResult {
  stdout: string;
  stderr?: string;
  exitCode: number | string | null | undefined;
  signal?: string | null;
  timedOut?: boolean;
  aborted?: boolean;
  errorMessage?: string;
}

type ClassifiedGrepResult =
  | { type: 'ok'; stdout: string; warning: string }
  | { type: 'error'; message: string };

function normalizeLocalGrepResult(
  stdout: string,
  error: ExecFileException | undefined,
  timedOut: boolean,
  aborted?: boolean,
): GrepProcessResult {
  return {
    stdout,
    exitCode: error ? error.code : 0,
    signal: error?.signal,
    timedOut,
    aborted: aborted || (error?.name === 'AbortError' && !timedOut),
    errorMessage: error?.message,
  };
}

function classifyGrepResult(result: GrepProcessResult): ClassifiedGrepResult {
  const hasStdout = result.stdout.trim().length > 0;
  if (result.aborted) {
    if (hasStdout) {
      return {
        type: 'ok',
        stdout: result.stdout,
        warning: '\n\n[grep aborted: partial results returned]',
      };
    }
    return { type: 'error', message: 'grep aborted' };
  }
  if (result.timedOut) {
    if (hasStdout) {
      return {
        type: 'ok',
        stdout: result.stdout,
        warning: '\n\n[grep timed out: partial results returned]',
      };
    }
    return { type: 'error', message: 'grep timed out' };
  }

  if (result.signal) {
    if (hasStdout) {
      return {
        type: 'ok',
        stdout: result.stdout,
        warning: `\n\n[grep killed by signal ${result.signal}: partial results returned]`,
      };
    }
    return { type: 'error', message: `grep killed by signal ${result.signal}` };
  }

  const code = result.exitCode;
  if (code === 0 || code === 1) {
    return { type: 'ok', stdout: result.stdout, warning: '' };
  }
  if (code === null) {
    if (hasStdout) {
      return {
        type: 'ok',
        stdout: result.stdout,
        warning: '\n\n[grep terminated without exit code]',
      };
    }
    return { type: 'error', message: 'grep terminated without exit code' };
  }
  if (code === undefined) {
    return { type: 'error', message: grepFailureMessage(result, 'grep ended without exit status') };
  }
  if (isMaxBufferError(result) && hasStdout) {
    return {
      type: 'ok',
      stdout: result.stdout,
      warning: '\n\n[grep output exceeded buffer: partial results returned]',
    };
  }
  if (hasStdout) {
    return {
      type: 'ok',
      stdout: result.stdout,
      warning: grepWarning(result, `grep exited ${code}`),
    };
  }
  return { type: 'error', message: grepFailureMessage(result, `grep failed with exit ${code}`) };
}

function isMaxBufferError(result: GrepProcessResult): boolean {
  return /maxBuffer|buffer length exceeded/i.test(result.errorMessage ?? '');
}

function grepFailureMessage(result: GrepProcessResult, fallback: string): string {
  return result.errorMessage || result.stderr?.trim() || fallback;
}

function grepWarning(result: GrepProcessResult, prefix: string): string {
  const detail = result.errorMessage || result.stderr?.trim();
  return detail
    ? `\n\n[${prefix}: ${detail}; partial results returned]`
    : `\n\n[${prefix}: partial results returned]`;
}
