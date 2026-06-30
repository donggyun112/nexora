/**
 * grep — pattern search across the workspace.
 *
 * Engine: ripgrep (`rg`) when available, else falls back to system `grep`.
 * ripgrep respects `.gitignore`, supports `--type`, rich globs and multiline;
 * the grep fallback covers the common options (pattern/path/glob/context/-i)
 * with those rg-only features disabled.
 *
 * Workspace boundary is enforced the same way as before: the search path is
 * resolved + canonicalized through safe-path / workspace-access, and result
 * paths are stripped back to workspace-relative. Output is shaped after
 * claude-code's GrepTool: output_mode (content | files_with_matches | count),
 * head_limit + offset pagination, and mtime-sorted file lists.
 */

import { execFile, type ExecFileException } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext, ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';
import { canonicalizePath, PathOutsideWorkspaceError, resolveDirForListing } from './safe-path.js';
import { buildToolEnv } from './tool-env.js';
import { resolveToolPath } from './workspace-access.js';

const GREP_TIMEOUT_MS = 120_000;
const GREP_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_HEAD_LIMIT = 250;
const MAX_COLUMNS = 500;

// Version-control metadata dirs — excluded so they don't drown real results.
const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const;

type OutputMode = 'content' | 'files_with_matches' | 'count';

interface GrepParams {
  pattern?: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: OutputMode;
  '-A'?: number;
  '-B'?: number;
  '-C'?: number;
  context?: number;
  '-n'?: boolean;
  '-i'?: boolean;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
}

// One-time engine probe, memoized for the process. Both the sandbox (workspace.run)
// and the local execFile paths agree on the engine so output parsing matches.
let enginePromise: Promise<'rg' | 'grep'> | null = null;
function detectEngine(): Promise<'rg' | 'grep'> {
  if (!enginePromise) {
    enginePromise = new Promise<'rg' | 'grep'>(resolve => {
      // SECURITY: bare name 'rg' (not an absolute path) so the OS resolves it
      // via PATH and a malicious ./rg in the workspace can't be executed.
      execFile('rg', ['--version'], { timeout: 5000 }, err => resolve(err ? 'grep' : 'rg'));
    });
  }
  return enginePromise;
}

export function createGrepTool(): ToolDefinition {
  const env = buildToolEnv();

  return {
    name: 'grep',
    description:
      'Search file contents for a regex pattern across the workspace (ripgrep when available, else grep). ' +
      'output_mode selects what to return: "files_with_matches" (default) lists matching file paths, ' +
      '"content" shows matching lines (supports -A/-B/-C context and -n line numbers), "count" shows per-file counts. ' +
      'Use path to scope to a subdirectory, glob ("*.ts", "*.{ts,tsx}") or type ("ts","py","rust") to filter files, ' +
      '-i for case-insensitive, multiline for patterns spanning lines. ' +
      'head_limit caps results (default 250, 0 = unlimited) and offset paginates. ' +
      'Returns "No matches found." when nothing matches (not an error).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for' },
        path: { type: 'string', description: '(Optional) file or subdirectory relative to the workspace' },
        glob: { type: 'string', description: '(Optional) filename glob filter, e.g. "*.ts" or "*.{ts,tsx}"' },
        type: { type: 'string', description: '(Optional, ripgrep only) file type, e.g. "js", "py", "rust"' },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'What to return. Default "files_with_matches".',
        },
        '-A': { type: 'number', description: '(content only) lines of context after each match' },
        '-B': { type: 'number', description: '(content only) lines of context before each match' },
        '-C': { type: 'number', description: '(content only) lines of context before and after' },
        context: { type: 'number', description: 'Alias for -C' },
        '-n': { type: 'boolean', description: '(content only) show line numbers (default true)' },
        '-i': { type: 'boolean', description: 'Case-insensitive search' },
        head_limit: { type: 'number', description: 'Cap output to first N entries (default 250; 0 = unlimited)' },
        offset: { type: 'number', description: 'Skip first N entries before head_limit (default 0)' },
        multiline: { type: 'boolean', description: '(ripgrep only) let patterns span lines' },
      },
      required: ['pattern'],
    },
    execute: async (_id, input, ctx): Promise<ToolResult> => {
      const params = input as GrepParams;

      const pattern = (params.pattern ?? '').trim();
      if (!pattern) return errorResult('pattern is required');

      // Default mirrors the previous grep (matching lines). files_with_matches /
      // count are opt-in; agents that just want matches keep the old behaviour.
      const outputMode: OutputMode = params.output_mode ?? 'content';
      const offset = clampInt(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const headLimit = params.head_limit === undefined
        ? DEFAULT_HEAD_LIMIT
        : clampInt(params.head_limit, DEFAULT_HEAD_LIMIT, 0, Number.MAX_SAFE_INTEGER);

      // Resolve + validate the search path inside the workspace (unchanged boundary).
      const subpath = params.path?.trim();
      let resolved;
      try {
        resolved = await resolveToolPath(ctx, subpath || '.', 'list');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
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
        return errorResult(`Cannot grep: ${err instanceof Error ? err.message : String(err)}`);
      }
      const stripRoots = uniqueRoots([realRoot, root]);

      const glob = params.glob?.trim();
      if (glob && glob.includes('..')) {
        return errorResult('glob must not contain ".."');
      }

      const engine = await detectEngine();
      const args = engine === 'rg'
        ? buildRgArgs(params, pattern, outputMode, glob, grepPath)
        : buildGrepArgs(params, pattern, outputMode, glob, grepPath);

      let proc: GrepProcessResult;
      try {
        proc = await runEngine(engine, args, root, env, ctx);
      } catch (err) {
        return errorResult(`Cannot grep: ${err instanceof Error ? err.message : String(err)}`);
      }

      const classified = classifyResult(proc);
      if (classified.type === 'error') return errorResult(classified.message);
      const { stdout, warning } = classified;

      const degraded = engine === 'grep' ? grepDegradationNote(params) : null;
      const tail = warning + (degraded ? `\n\n${degraded}` : '');

      const rawLines = stdout.split('\n').filter(line => line.length > 0);
      if (rawLines.length === 0) return textResult('No matches found.' + tail);

      if (outputMode === 'files_with_matches') {
        return formatFiles(rawLines, stripRoots, offset, headLimit, tail);
      }
      if (outputMode === 'count') {
        return formatCount(rawLines, stripRoots, offset, headLimit, tail);
      }
      return formatContent(rawLines, stripRoots, offset, headLimit, tail);
    },
  };
}

// ─── argument builders ──────────────────────────────────────────────────────

function buildRgArgs(
  params: GrepParams,
  pattern: string,
  outputMode: OutputMode,
  glob: string | undefined,
  target: string,
): string[] {
  const args = ['--hidden'];
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) args.push('--glob', `!${dir}`);
  args.push('--max-columns', String(MAX_COLUMNS));

  if (params.multiline) args.push('-U', '--multiline-dotall');
  if (params['-i']) args.push('-i');

  if (outputMode === 'files_with_matches') args.push('-l');
  else if (outputMode === 'count') args.push('-c');

  if (outputMode === 'content') {
    if (params['-n'] ?? true) args.push('-n');
    pushContextArgs(args, params);
  }

  pushPattern(args, pattern);
  if (params.type) args.push('--type', params.type);
  for (const g of splitGlobPatterns(glob)) args.push('--glob', g);

  args.push(target);
  return args;
}

function buildGrepArgs(
  params: GrepParams,
  pattern: string,
  outputMode: OutputMode,
  glob: string | undefined,
  target: string,
): string[] {
  const args = ['-rE', '--color=never'];
  if (params['-i']) args.push('-i');

  if (outputMode === 'files_with_matches') args.push('-l');
  else if (outputMode === 'count') args.push('-c');

  if (outputMode === 'content') {
    if (params['-n'] ?? true) args.push('-n');
    pushContextArgs(args, params);
  }

  // grep has no --type/gitignore; map concrete (non-path) globs to --include.
  for (const g of splitGlobPatterns(glob)) {
    if (!g.includes('/')) args.push(`--include=${g}`);
  }

  args.push('--');
  pushPattern(args, pattern);
  args.push(target);
  return args;
}

function pushContextArgs(args: string[], params: GrepParams): void {
  // -C / context wins over the separate -A/-B (claude-code precedence).
  if (params.context !== undefined) args.push('-C', String(Math.max(0, Math.trunc(params.context))));
  else if (params['-C'] !== undefined) args.push('-C', String(Math.max(0, Math.trunc(params['-C']))));
  else {
    if (params['-B'] !== undefined) args.push('-B', String(Math.max(0, Math.trunc(params['-B']))));
    if (params['-A'] !== undefined) args.push('-A', String(Math.max(0, Math.trunc(params['-A']))));
  }
}

function pushPattern(args: string[], pattern: string): void {
  // A pattern starting with '-' must go behind -e or it's read as a flag.
  if (pattern.startsWith('-')) args.push('-e', pattern);
  else args.push(pattern);
}

// Split a glob string on whitespace/commas while keeping brace groups intact
// ("*.{ts,tsx}" stays one pattern).
function splitGlobPatterns(glob: string | undefined): string[] {
  if (!glob) return [];
  const out: string[] = [];
  for (const raw of glob.split(/\s+/).filter(Boolean)) {
    if (raw.includes('{') && raw.includes('}')) out.push(raw);
    else out.push(...raw.split(',').filter(Boolean));
  }
  return out;
}

function grepDegradationNote(params: GrepParams): string | null {
  const lost: string[] = [];
  if (params.type) lost.push('type');
  if (params.multiline) lost.push('multiline');
  lost.push('.gitignore not respected');
  return `[grep fallback: ripgrep not found — ${lost.join(', ')} unavailable]`;
}

// ─── engine execution ───────────────────────────────────────────────────────

interface GrepProcessResult {
  stdout: string;
  exitCode: number | string | null | undefined;
  signal?: string | null;
  timedOut?: boolean;
  aborted?: boolean;
  errorMessage?: string;
  stderr?: string;
}

async function runEngine(
  engine: 'rg' | 'grep',
  args: string[],
  cwd: string,
  env: Record<string, string>,
  ctx: ToolContext,
): Promise<GrepProcessResult> {
  if (ctx.workspace?.run) {
    const result = await ctx.workspace.run({
      argv: [engine, ...args],
      cwd,
      env,
      signal: ctx.signal,
      timeoutMs: GREP_TIMEOUT_MS,
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
  }, GREP_TIMEOUT_MS);
  timer.unref?.();
  const onParentAbort = (): void => {
    if (settled) return;
    parentAbort = true;
    controller.abort();
  };
  if (ctx.signal?.aborted) onParentAbort();
  else ctx.signal?.addEventListener('abort', onParentAbort, { once: true });

  const local = await new Promise<{ stdout: string; error?: ExecFileException }>(resolve => {
    execFile(engine, args, { env, cwd, maxBuffer: GREP_MAX_BUFFER, signal: controller.signal }, (err, out) => {
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

type Classified =
  | { type: 'ok'; stdout: string; warning: string }
  | { type: 'error'; message: string };

function classifyResult(result: GrepProcessResult): Classified {
  const hasStdout = result.stdout.trim().length > 0;
  if (result.aborted) {
    return hasStdout
      ? { type: 'ok', stdout: result.stdout, warning: '\n\n[grep aborted: partial results returned]' }
      : { type: 'error', message: 'grep aborted' };
  }
  if (result.timedOut) {
    return hasStdout
      ? { type: 'ok', stdout: result.stdout, warning: '\n\n[grep timed out: partial results returned]' }
      : { type: 'error', message: 'grep timed out' };
  }
  if (result.signal) {
    return hasStdout
      ? { type: 'ok', stdout: result.stdout, warning: `\n\n[grep killed by signal ${result.signal}: partial results returned]` }
      : { type: 'error', message: `grep killed by signal ${result.signal}` };
  }

  const code = result.exitCode;
  // 0 = matches, 1 = no matches: both are success for grep and ripgrep.
  if (code === 0 || code === 1) return { type: 'ok', stdout: result.stdout, warning: '' };
  if (code === null) {
    return hasStdout
      ? { type: 'ok', stdout: result.stdout, warning: '\n\n[grep terminated without exit code]' }
      : { type: 'error', message: 'grep terminated without exit code' };
  }
  if (code === undefined) {
    return { type: 'error', message: grepFailureMessage(result, 'grep ended without exit status') };
  }
  if (isMaxBufferError(result) && hasStdout) {
    return { type: 'ok', stdout: result.stdout, warning: '\n\n[grep output exceeded buffer: partial results returned]' };
  }
  if (hasStdout) {
    return { type: 'ok', stdout: result.stdout, warning: grepWarning(result, `grep exited ${code}`) };
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

// ─── output formatting ───────────────────────────────────────────────────────

// Files mode sorts by mtime (newest first) like claude-code, so stat each match.
async function formatFiles(
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

function formatCount(
  lines: string[],
  roots: string[],
  offset: number,
  headLimit: number,
  tail: string,
): ToolResult {
  const { items, appliedLimit } = applyHeadLimit(lines, headLimit, offset);
  let totalMatches = 0;
  const out = items.map(line => {
    const idx = line.lastIndexOf(':');
    if (idx > 0) {
      const n = parseInt(line.slice(idx + 1), 10);
      if (!Number.isNaN(n)) totalMatches += n;
      return stripWorkspacePrefix(line.slice(0, idx), roots) + line.slice(idx);
    }
    return stripWorkspacePrefix(line, roots);
  });
  const files = out.length;
  const limitInfo = formatLimitInfo(appliedLimit, offset);
  const summary = `\n\nFound ${totalMatches} total ${totalMatches === 1 ? 'occurrence' : 'occurrences'} across ${files} ${files === 1 ? 'file' : 'files'}.${limitInfo ? ` (${limitInfo})` : ''}`;
  return textResult(out.join('\n') + summary + tail);
}

function formatContent(
  lines: string[],
  roots: string[],
  offset: number,
  headLimit: number,
  tail: string,
): ToolResult {
  const { items, appliedLimit } = applyHeadLimit(lines, headLimit, offset);
  const out = items.map(line => {
    const idx = line.indexOf(':');
    if (idx > 0) return stripWorkspacePrefix(line.slice(0, idx), roots) + line.slice(idx);
    return line;
  });
  const limitInfo = formatLimitInfo(appliedLimit, offset);
  const footer = limitInfo ? `\n\n[pagination: ${limitInfo}]` : '';
  return textResult(out.join('\n') + footer + tail);
}

function applyHeadLimit(
  items: string[],
  limit: number,
  offset: number,
): { items: string[]; appliedLimit?: number } {
  if (limit === 0) return { items: items.slice(offset) };
  const sliced = items.slice(offset, offset + limit);
  const truncated = items.length - offset > limit;
  return { items: sliced, ...(truncated ? { appliedLimit: limit } : {}) };
}

function formatLimitInfo(appliedLimit: number | undefined, offset: number): string {
  const parts: string[] = [];
  if (appliedLimit !== undefined) parts.push(`limit ${appliedLimit}`);
  if (offset) parts.push(`offset ${offset}`);
  return parts.join(', ');
}

// ─── path helpers (unchanged from the previous grep) ─────────────────────────

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

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
