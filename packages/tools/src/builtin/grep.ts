/**
 * grep — 패턴 검색 도구.
 *
 * 시스템 grep을 호출 (-rEn). workdir 기준.
 * include 글롭으로 파일 필터, context 옵션.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ToolDefinition, ToolResult } from '@dongkseo/contracts';
import { textResult, errorResult } from '@dongkseo/contracts';

const MAX_LINES = 200;

export function createGrepTool(): ToolDefinition {
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

      const root = path.resolve(ctx.workdir);
      const subpath = params.path?.trim();
      const searchPath = subpath ? path.resolve(root, subpath) : root;

      if (!searchPath.startsWith(root + path.sep) && searchPath !== root) {
        return errorResult('path is outside workspace root');
      }

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
      args.push(pattern, searchPath);

      const stdout = await new Promise<string>((resolve) => {
        execFile('grep', args, { maxBuffer: 4 * 1024 * 1024 }, (_err, out) => resolve(out));
      });

      if (!stdout.trim()) return textResult('No matches found.');

      const lines = stdout
        .trimEnd()
        .split('\n')
        .map(line => line.startsWith(root + path.sep) ? line.slice(root.length + 1) : line);

      if (lines.length > MAX_LINES) {
        return textResult(
          lines.slice(0, MAX_LINES).join('\n') +
          `\n\n[Truncated: showing ${MAX_LINES} of ${lines.length} lines]`,
        );
      }

      return textResult(lines.join('\n'));
    },
  };
}
