/**
 * glob — file-name pattern matching across the workspace.
 *
 * Sibling of grep: same engine seam (ripgrep via ctx.workspace.run under a
 * sandbox/remote session, else a local execFile), same workspace-boundary
 * resolution (WorkspaceFs.realPath), same mtime-sorted file output with
 * head_limit/offset pagination and workspace-relative paths — all shared from
 * ./search-engine.js so the two tools stay 1:1.
 *
 * Engine: ripgrep only. `rg --files --glob <pattern>` lists files matching the
 * glob; there is no POSIX tool with matching `**` semantics, so rather than
 * degrade to a different-behaving `find`, the tool reports that ripgrep is
 * unavailable. (Sandbox/remote runtimes ship rg; grep probes rg the same way.)
 *
 * Ignore posture mirrors grep — `.gitignore` respected, hidden dirs (.git/…)
 * skipped: no `--hidden`/`--no-ignore`. That keeps glob and grep consistent,
 * avoids flooding a monorepo glob with node_modules/dist, and sidesteps the
 * sandbox '!'-glob escaping bug grep documents (we inject no '!' exclusions).
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
  uniqueRoots,
  clampInt,
} from './search-engine.js';

interface GlobParams {
  pattern?: string;
  path?: string;
  head_limit?: number;
  offset?: number;
}

export function createGlobTool(): ToolDefinition {
  const env = buildToolEnv();

  return {
    name: 'glob',
    description:
      'Find files by name/path pattern across the workspace (ripgrep). ' +
      'Supports glob patterns like "**/*.ts" or "src/**/*.{ts,tsx}". ' +
      'Returns matching file paths sorted by modification time (newest first). ' +
      'Use path to scope the search to a subdirectory. ' +
      'Respects .gitignore and skips hidden dirs (.git/…). ' +
      'Use grep to search file *contents*; use glob to find files by name. ' +
      'head_limit caps results (default 250, 0 = unlimited) and offset paginates. ' +
      'Returns "No files found." when nothing matches (not an error).',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match file paths against, e.g. "**/*.ts" or "src/**/*.{ts,tsx}"',
        },
        path: {
          type: 'string',
          description: '(Optional) subdirectory relative to the workspace to search within',
        },
        head_limit: { type: 'number', description: 'Cap output to first N files (default 250; 0 = unlimited)' },
        offset: { type: 'number', description: 'Skip first N files before head_limit (default 0)' },
      },
      required: ['pattern'],
    },
    execute: async (_id, input, ctx): Promise<ToolResult> => {
      const params = input as GlobParams;

      const pattern = (params.pattern ?? '').trim();
      if (!pattern) return errorResult('pattern is required');
      // A ripgrep walk never ascends out of its search root, but reject '..' up
      // front for parity with grep's glob guard and to keep intent unambiguous.
      if (pattern.includes('..')) return errorResult('pattern must not contain ".."');

      const offset = clampInt(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const headLimit = params.head_limit === undefined
        ? DEFAULT_HEAD_LIMIT
        : clampInt(params.head_limit, DEFAULT_HEAD_LIMIT, 0, Number.MAX_SAFE_INTEGER);

      // Resolve + validate the search path through the active workspace runtime
      // (local realpath+jail, or remote lexical + server-enforced) — same seam
      // as grep, so glob is backend-agnostic with no local/remote branching.
      const subpath = params.path?.trim();
      const { fs } = workspaceFs(ctx);
      let searchPath: string;
      let realRoot: string;
      try {
        const r = await fs.realPath(subpath || '.');
        searchPath = r.path;
        realRoot = r.root;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return textResult('No files found.');
        if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
        return errorResult(`Cannot glob: ${err instanceof Error ? err.message : String(err)}`);
      }
      const root = realRoot;
      const stripRoots = uniqueRoots([realRoot]);

      const engine = await detectEngine();
      if (engine !== 'rg') {
        // No POSIX equivalent for `--files --glob`; a `find` fallback would
        // behave differently, so fail honestly instead of degrading silently.
        return errorResult('glob requires ripgrep (rg), which was not found on PATH');
      }

      // `rg --files -g <pattern> <dir>` lists files under <dir> matching the
      // glob. No --hidden / --no-ignore (see file header).
      const args = ['--files', '--glob', pattern, searchPath];

      let proc;
      try {
        proc = await runEngine('rg', args, root, env, ctx);
      } catch (err) {
        return errorResult(`Cannot glob: ${err instanceof Error ? err.message : String(err)}`);
      }

      const classified = classifyResult(proc, 'glob');
      if (classified.type === 'error') return errorResult(classified.message);
      const { stdout, warning } = classified;

      const rawLines = stdout.split('\n').filter(line => line.length > 0);
      if (rawLines.length === 0) return textResult('No files found.' + warning);

      return formatFiles(rawLines, stripRoots, offset, headLimit, warning);
    },
  };
}
