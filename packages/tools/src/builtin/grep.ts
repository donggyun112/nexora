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

import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';
import { PathOutsideWorkspaceError } from './safe-path.js';
import { buildToolEnv } from './tool-env.js';
import { workspaceFs } from './workspace-access.js';
import {
  DEFAULT_HEAD_LIMIT,
  detectEngine,
  runEngine,
  classifyResult,
  formatFiles,
  applyHeadLimit,
  formatLimitInfo,
  uniqueRoots,
  stripWorkspacePrefix,
  clampInt,
} from './search-engine.js';

const MAX_COLUMNS = 500;

// Version-control metadata dirs are skipped for free: ripgrep ignores hidden
// dirs (.git/.svn/…) by default since we no longer pass --hidden.

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

      // Resolve + validate the search path through the active workspace runtime
      // (local realpath+jail, or remote lexical + server-enforced) — no per-tool
      // local/remote branching. `workspaceFs` also covers the no-session case
      // with a filesystem runtime jailed to ctx.workdir.
      const subpath = params.path?.trim();
      const { fs } = workspaceFs(ctx);
      let grepPath: string;
      let realRoot: string;
      try {
        const r = await fs.realPath(subpath || '.');
        grepPath = r.path;
        realRoot = r.root;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return textResult('No matches found.');
        if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
        return errorResult(`Cannot grep: ${err instanceof Error ? err.message : String(err)}`);
      }
      const root = realRoot;
      const stripRoots = uniqueRoots([realRoot]);

      const glob = params.glob?.trim();
      if (glob && glob.includes('..')) {
        return errorResult('glob must not contain ".."');
      }

      const engine = await detectEngine();
      const args = engine === 'rg'
        ? buildRgArgs(params, pattern, outputMode, glob, grepPath)
        : buildGrepArgs(params, pattern, outputMode, glob, grepPath);

      let proc;
      try {
        proc = await runEngine(engine, args, root, env, ctx);
      } catch (err) {
        return errorResult(`Cannot grep: ${err instanceof Error ? err.message : String(err)}`);
      }

      const classified = classifyResult(proc, 'grep');
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
  // No `--hidden`: ripgrep then skips hidden dirs (incl. .git/.svn/…) by default,
  // so we don't need `--glob '!.git'` excludes. That matters because the sandbox
  // runs the engine through a shell and sandbox-runtime escapes a leading '!' to
  // '\!', which ripgrep reads as a literal-'!' *include* glob (matching nothing) —
  // turning every search into "No matches found." Avoiding '!' globs sidesteps it.
  const args = ['--max-columns', String(MAX_COLUMNS)];

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

// ─── output formatting (grep-specific modes) ─────────────────────────────────

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
