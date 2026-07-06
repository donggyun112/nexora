/**
 * Shared search spine for the workspace search tools (grep, glob).
 *
 * Both tools resolve their path through `WorkspaceFs.realPath`, then run an
 * external engine (ripgrep, else system grep for content search) over the
 * active runtime — `ctx.workspace.run` under a sandbox/remote session, or a
 * local `execFile` when there is no session. This module owns that engine seam
 * plus the result plumbing they share: one memoized engine probe, process
 * classification (exit codes, timeout/abort/signal, maxBuffer), the mtime-sorted
 * file listing, and the head_limit/offset + workspace-relative path shaping.
 *
 * Keeping this in one place is what makes grep and glob true siblings: identical
 * pagination contract, identical boundary stripping, identical failure modes.
 */

import { execFile, type ExecFileException } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext, ToolResult } from '@dongkseo/contracts';
import { textResult } from '@dongkseo/contracts';

export const SEARCH_TIMEOUT_MS = 120_000;
export const SEARCH_MAX_BUFFER = 16 * 1024 * 1024;
export const DEFAULT_HEAD_LIMIT = 250;

export type SearchEngine = 'rg' | 'grep';

// One-time engine probe, memoized for the process. Both the sandbox (workspace.run)
// and the local execFile paths agree on the engine so output parsing matches.
let enginePromise: Promise<SearchEngine> | null = null;
export function detectEngine(): Promise<SearchEngine> {
  if (!enginePromise) {
    enginePromise = new Promise<SearchEngine>(resolve => {
      // SECURITY: bare name 'rg' (not an absolute path) so the OS resolves it
      // via PATH and a malicious ./rg in the workspace can't be executed.
      execFile('rg', ['--version'], { timeout: 5000 }, err => resolve(err ? 'grep' : 'rg'));
    });
  }
  return enginePromise;
}

export interface EngineProcessResult {
  stdout: string;
  exitCode: number | string | null | undefined;
  signal?: string | null;
  timedOut?: boolean;
  aborted?: boolean;
  errorMessage?: string;
  stderr?: string;
}

export async function runEngine(
  engine: SearchEngine,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  ctx: ToolContext,
): Promise<EngineProcessResult> {
  if (ctx.workspace?.run) {
    const result = await ctx.workspace.run({
      argv: [engine, ...args],
      cwd,
      env,
      signal: ctx.signal,
      timeoutMs: SEARCH_TIMEOUT_MS,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
  }

  let timedOut = false;
  let parentAbort = false;
  let settled = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SEARCH_TIMEOUT_MS);
  timer.unref?.();
  const onParentAbort = (): void => {
    if (settled) return;
    parentAbort = true;
    controller.abort();
  };
  if (ctx.signal?.aborted) onParentAbort();
  else ctx.signal?.addEventListener('abort', onParentAbort, { once: true });

  const local = await new Promise<{ stdout: string; error?: ExecFileException }>(resolve => {
    execFile(engine, args, { env, cwd, maxBuffer: SEARCH_MAX_BUFFER, signal: controller.signal }, (err, out) => {
      settled = true;
      resolve({ stdout: out ?? '', error: err ?? undefined });
    });
  });
  clearTimeout(timer);
  ctx.signal?.removeEventListener('abort', onParentAbort);

  return {
    stdout: local.stdout,
    exitCode: local.error ? local.error.code : 0,
    signal: local.error?.signal,
    timedOut,
    aborted: parentAbort || (local.error?.name === 'AbortError' && !timedOut),
    errorMessage: local.error?.message,
  };
}

export type Classified =
  | { type: 'ok'; stdout: string; warning: string }
  | { type: 'error'; message: string };

/**
 * Map a finished engine process to success-with-partial-results or an error.
 * `noun` names the tool in messages ("grep"/"glob") so callers read naturally.
 */
export function classifyResult(result: EngineProcessResult, noun = 'grep'): Classified {
  const hasStdout = result.stdout.trim().length > 0;
  if (result.aborted) {
    return hasStdout
      ? { type: 'ok', stdout: result.stdout, warning: `\n\n[${noun} aborted: partial results returned]` }
      : { type: 'error', message: `${noun} aborted` };
  }
  if (result.timedOut) {
    return hasStdout
      ? { type: 'ok', stdout: result.stdout, warning: `\n\n[${noun} timed out: partial results returned]` }
      : { type: 'error', message: `${noun} timed out` };
  }
  if (result.signal) {
    return hasStdout
      ? { type: 'ok', stdout: result.stdout, warning: `\n\n[${noun} killed by signal ${result.signal}: partial results returned]` }
      : { type: 'error', message: `${noun} killed by signal ${result.signal}` };
  }

  const code = result.exitCode;
  // 0 = matches, 1 = no matches: both are success for grep and ripgrep.
  if (code === 0 || code === 1) return { type: 'ok', stdout: result.stdout, warning: '' };
  if (code === null) {
    return hasStdout
      ? { type: 'ok', stdout: result.stdout, warning: `\n\n[${noun} terminated without exit code]` }
      : { type: 'error', message: `${noun} terminated without exit code` };
  }
  if (code === undefined) {
    return { type: 'error', message: failureMessage(result, `${noun} ended without exit status`) };
  }
  if (isMaxBufferError(result) && hasStdout) {
    return { type: 'ok', stdout: result.stdout, warning: `\n\n[${noun} output exceeded buffer: partial results returned]` };
  }
  if (hasStdout) {
    return { type: 'ok', stdout: result.stdout, warning: warningMessage(result, `${noun} exited ${code}`) };
  }
  return { type: 'error', message: failureMessage(result, `${noun} failed with exit ${code}`) };
}

function isMaxBufferError(result: EngineProcessResult): boolean {
  return /maxBuffer|buffer length exceeded/i.test(result.errorMessage ?? '');
}

function failureMessage(result: EngineProcessResult, fallback: string): string {
  return result.errorMessage || result.stderr?.trim() || fallback;
}

function warningMessage(result: EngineProcessResult, prefix: string): string {
  const detail = result.errorMessage || result.stderr?.trim();
  return detail
    ? `\n\n[${prefix}: ${detail}; partial results returned]`
    : `\n\n[${prefix}: partial results returned]`;
}

// Files mode sorts by mtime (newest first) like claude-code, so stat each match.
export async function formatFiles(
  absoluteLines: string[],
  roots: string[],
  offset: number,
  headLimit: number,
  tail: string,
): Promise<ToolResult> {
  const stats = await Promise.allSettled(absoluteLines.map(p => fsp.stat(p)));
  const sorted = absoluteLines
    .map((p, i) => {
      const r = stats[i]!;
      return [p, r.status === 'fulfilled' ? (r.value.mtimeMs ?? 0) : 0] as const;
    })
    .sort((a, b) => {
      const byTime = b[1] - a[1];
      return byTime !== 0 ? byTime : a[0].localeCompare(b[0]);
    })
    .map(e => e[0]);

  const { items, appliedLimit } = applyHeadLimit(sorted, headLimit, offset);
  const rels = items.map(p => stripWorkspacePrefix(p, roots));
  const limitInfo = formatLimitInfo(appliedLimit, offset);
  const header = `Found ${rels.length} ${rels.length === 1 ? 'file' : 'files'}${limitInfo ? ` (${limitInfo})` : ''}`;
  return textResult(`${header}\n${rels.join('\n')}${tail}`);
}

export function applyHeadLimit(
  items: string[],
  limit: number,
  offset: number,
): { items: string[]; appliedLimit?: number } {
  if (limit === 0) return { items: items.slice(offset) };
  const sliced = items.slice(offset, offset + limit);
  const truncated = items.length - offset > limit;
  return { items: sliced, ...(truncated ? { appliedLimit: limit } : {}) };
}

export function formatLimitInfo(appliedLimit: number | undefined, offset: number): string {
  const parts: string[] = [];
  if (appliedLimit !== undefined) parts.push(`limit ${appliedLimit}`);
  if (offset) parts.push(`offset ${offset}`);
  return parts.join(', ');
}

export function uniqueRoots(roots: string[]): string[] {
  return [...new Set(roots)].sort((a, b) => b.length - a.length);
}

export function stripWorkspacePrefix(line: string, roots: string[]): string {
  for (const root of roots) {
    if (line.startsWith(root + path.sep)) return line.slice(root.length + 1);
    if (line.startsWith(`${root}:`)) return `.${line.slice(root.length)}`;
  }
  return line;
}

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
