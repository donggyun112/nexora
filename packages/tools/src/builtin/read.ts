/**
 * read — file/directory reader.
 *
 * Workspace boundary is enforced via fd-based opens with O_NOFOLLOW (see
 * safe-path.ts). Symlinks at the final path component are refused at the
 * kernel level, eliminating the TOCTOU window between resolve() and read().
 *
 * Beyond plain text + single images it also reads:
 *   - Jupyter notebooks (.ipynb) → text (code/markdown) + output images
 *   - PDFs (.pdf) → page images via poppler (pdfinfo/pdftoppm); `pages` selects a range
 * and dedups unchanged re-reads via ctx.readFileState (the earlier result is
 * still in context, so re-sending the whole file just wastes cache).
 */

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolResultContentBlock,
} from '@dongkseo/contracts';
import { textResult, errorResult, contentResult } from '@dongkseo/contracts';
import {
  openForRead,
  resolveDirForListing,
  canonicalizePath,
  PathOutsideWorkspaceError,
  SymlinkRefusedError,
} from './safe-path.js';
import { buildToolEnv } from './tool-env.js';
import { resolveToolPath } from './workspace-access.js';

const MAX_LINES = 2000;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB hard cap (text)
const PDF_DPI = 100;
const PDF_MAX_PAGES_PER_READ = 20;
const NOTEBOOK_OUTPUT_LIMIT = 10 * 1024; // skip huge cell outputs

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

interface ReadParams {
  path?: string;
  offset?: number;
  limit?: number;
  pages?: string;
}

export function createReadTool(): ToolDefinition {
  const env = buildToolEnv();

  return {
    name: 'read',
    description:
      'Read a file from the workspace. Text files return up to 2000 line-numbered lines; ' +
      'use offset (1-based) and limit to page through large files. Images return inline. ' +
      'Jupyter notebooks (.ipynb) return cell sources and output images. ' +
      'PDFs (.pdf) return page images — use pages (e.g. "1-5", "3") to select a range. ' +
      'A directory path lists its contents instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute or relative to workdir)' },
        offset: { type: 'number', description: '1-based line number to start from (text)' },
        limit: { type: 'number', description: 'Maximum number of lines to return (text)' },
        pages: { type: 'string', description: 'Page range for PDFs, e.g. "1-5", "3", "10-20"' },
      },
      required: ['path'],
    },
    execute: async (_id, input, ctx): Promise<ToolResult> => {
      const params = input as ReadParams;
      const rawPath = (params.path ?? '').trim();
      if (!rawPath) return errorResult('path is required');

      let resolved;
      try {
        resolved = await resolveToolPath(ctx, rawPath, 'read');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
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
        if (code === 'ENOENT') return notFound(rawPath, workdir, toolPath);
        if (code === 'EISDIR') return readDirectory(toolPath, workdir);
        return errorResult(`Cannot read: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const stat = await handle.stat();
        if (stat.isDirectory()) {
          await handle.close().catch(() => {});
          handle = null;
          return readDirectory(toolPath, workdir);
        }
        if (!stat.isFile()) {
          return errorResult(`Cannot read: ${rawPath} is not a regular file`);
        }

        const ext = path.extname(toolPath).toLowerCase();

        // --- Jupyter notebook ---
        if (ext === '.ipynb') {
          if (stat.size > MAX_BYTES) {
            return errorResult(`Cannot read: ${rawPath} exceeds ${MAX_BYTES} byte cap (${stat.size} bytes)`);
          }
          const raw = await handle.readFile('utf-8');
          return readNotebook(rawPath, raw);
        }

        // --- Image ---
        const imageMime = IMAGE_MIME_BY_EXT[ext];
        if (imageMime) {
          const bytes = await handle.readFile();
          return { type: 'image', data: bytes.toString('base64'), mimeType: imageMime };
        }

        // --- PDF (poppler) ---
        if (ext === '.pdf') {
          await handle.close().catch(() => {});
          handle = null;
          return readPdf(rawPath, toolPath, workdir, params.pages, env, ctx.signal);
        }

        // --- Text ---
        if (stat.size > MAX_BYTES) {
          return errorResult(`Cannot read: ${rawPath} exceeds ${MAX_BYTES} byte cap (${stat.size} bytes)`);
        }

        // Dedup: identical re-read of an unchanged file → stub (content already in context).
        const absKey = path.resolve(workdir, toolPath);
        const mtimeMs = Math.floor(stat.mtimeMs);
        const prior = ctx.readFileState?.get(absKey);
        if (
          prior &&
          prior.mtimeMs === mtimeMs &&
          prior.size === stat.size &&
          prior.offset === params.offset &&
          prior.limit === params.limit
        ) {
          return textResult(
            `<file unchanged since you last read it — its content is already in context: ${rawPath}>`,
          );
        }

        const content = await handle.readFile('utf-8');
        const allLines = content.split('\n');
        const totalLines = allLines.length;

        const start = params.offset && params.offset > 0 ? params.offset - 1 : 0;
        const count = params.limit && params.limit > 0 ? Math.min(params.limit, MAX_LINES) : MAX_LINES;
        const end = Math.min(start + count, totalLines);

        const numbered = allLines
          .slice(start, end)
          .map((line, i) => `${String(start + i + 1).padStart(6)}→${line}`)
          .join('\n');

        let text = numbered;
        if (end < totalLines) {
          text += `\n\n[Showing lines ${start + 1}-${end} of ${totalLines}. Use offset=${end + 1} to continue.]`;
        }

        ctx.readFileState?.set(absKey, { mtimeMs, size: stat.size, offset: params.offset, limit: params.limit });
        return textResult(text);
      } catch (err) {
        return errorResult(`Cannot read: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
    },
  };
}

// ─── not-found suggestion ────────────────────────────────────────────────────

async function notFound(rawPath: string, workdir: string, toolPath: string): Promise<ToolResult> {
  const abs = path.resolve(workdir, toolPath);
  const similar = await findSimilarFile(abs);
  let msg = `Cannot read: ${rawPath} not found`;
  if (similar) {
    const rel = similar.startsWith(workdir + path.sep) ? path.relative(workdir, similar) : similar;
    msg += `. Did you mean ${rel}?`;
  }
  return errorResult(msg);
}

// Same basename, different extension, in the same directory (e.g. foo.ts vs foo.tsx).
async function findSimilarFile(absPath: string): Promise<string | undefined> {
  const dir = path.dirname(absPath);
  const self = path.basename(absPath);
  const stem = path.basename(absPath, path.extname(absPath));
  try {
    const entries = await fsp.readdir(dir);
    const match = entries.find(e => e !== self && path.basename(e, path.extname(e)) === stem);
    return match ? path.join(dir, match) : undefined;
  } catch {
    return undefined;
  }
}

// ─── directory listing ───────────────────────────────────────────────────────

async function readDirectory(rawPath: string, workdir: string): Promise<ToolResult> {
  let dirPath: string;
  try {
    dirPath = await resolveDirForListing(rawPath, workdir);
  } catch (err) {
    if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
    return errorResult(`Cannot read: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const lines = entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    return textResult(`Directory: ${dirPath}\n\n${lines.join('\n')}`);
  } catch (err) {
    return errorResult(`Cannot read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── notebook ────────────────────────────────────────────────────────────────

interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
  outputs?: NotebookOutput[];
}
interface NotebookOutput {
  output_type?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

function joinSource(source: string | string[] | undefined): string {
  if (Array.isArray(source)) return source.join('');
  return source ?? '';
}

function readNotebook(rawPath: string, raw: string): ToolResult {
  let nb: { cells?: NotebookCell[] };
  try {
    nb = JSON.parse(raw) as { cells?: NotebookCell[] };
  } catch {
    return errorResult(`Cannot read: ${rawPath} is not valid notebook JSON`);
  }
  const cells = Array.isArray(nb.cells) ? nb.cells : [];
  const blocks: ToolResultContentBlock[] = [];
  let textBuf = `Notebook: ${rawPath} (${cells.length} cell${cells.length === 1 ? '' : 's'})`;

  const flushText = (): void => {
    if (textBuf) {
      blocks.push({ type: 'text', text: textBuf });
      textBuf = '';
    }
  };

  cells.forEach((cell, i) => {
    const kind = cell.cell_type ?? 'code';
    const src = joinSource(cell.source);
    textBuf += `\n\n[cell ${i + 1} · ${kind}]`;
    if (src) textBuf += `\n${src}`;

    for (const out of cell.outputs ?? []) {
      const rendered = renderOutput(out);
      if (rendered.text) textBuf += `\n--- output ---\n${rendered.text}`;
      for (const img of rendered.images) {
        flushText();
        blocks.push(img);
      }
    }
  });
  flushText();

  return contentResult(blocks);
}

function renderOutput(out: NotebookOutput): { text: string; images: ToolResultContentBlock[] } {
  const images: ToolResultContentBlock[] = [];
  let text = '';
  const data = out.data ?? {};

  // Images first (PNG/JPEG embedded as base64; Jupyter may store as string or string[]).
  for (const mime of ['image/png', 'image/jpeg'] as const) {
    const val = data[mime];
    const b64 = Array.isArray(val) ? val.join('') : typeof val === 'string' ? val : null;
    if (b64) images.push({ type: 'image', data: b64.replace(/\s/g, ''), mimeType: mime });
  }

  if (out.output_type === 'stream') {
    text = joinSource(out.text);
  } else if (out.output_type === 'error') {
    text = `${out.ename ?? 'Error'}: ${out.evalue ?? ''}`;
  } else {
    const plain = data['text/plain'];
    if (typeof plain === 'string') text = plain;
    else if (Array.isArray(plain)) text = plain.join('');
  }

  if (text.length > NOTEBOOK_OUTPUT_LIMIT) {
    text = `${text.slice(0, NOTEBOOK_OUTPUT_LIMIT)}\n…[output truncated]`;
  }
  return { text, images };
}

// ─── PDF (poppler) ───────────────────────────────────────────────────────────

async function readPdf(
  rawPath: string,
  toolPath: string,
  workdir: string,
  pagesParam: string | undefined,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  let absPath: string;
  try {
    absPath = await canonicalizePath(toolPath, workdir);
  } catch (err) {
    if (err instanceof PathOutsideWorkspaceError) return errorResult(err.message);
    return errorResult(`Cannot read PDF: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pageCount = await getPdfPageCount(absPath, env, signal);
  if (pageCount === 'no-poppler') {
    return errorResult(
      'Cannot read PDF: poppler not found. Install it (macOS: `brew install poppler`, Debian/Ubuntu: `apt-get install poppler-utils`).',
    );
  }

  let first = 1;
  let last = pageCount ?? PDF_MAX_PAGES_PER_READ;
  if (pagesParam) {
    const range = parsePageRange(pagesParam);
    if (!range) return errorResult(`Invalid pages "${pagesParam}". Use "1-5", "3", or "10-20" (1-indexed).`);
    first = range.first;
    last = range.last === Infinity ? (pageCount ?? range.first) : range.last;
  } else if (pageCount !== null && pageCount > PDF_MAX_PAGES_PER_READ) {
    return errorResult(
      `This PDF has ${pageCount} pages — too many to read at once. Use pages (e.g. "1-5"), max ${PDF_MAX_PAGES_PER_READ} per request.`,
    );
  }

  if (last < first) return errorResult(`Invalid pages "${pagesParam}": end before start.`);
  if (last - first + 1 > PDF_MAX_PAGES_PER_READ) {
    return errorResult(`Page range exceeds the ${PDF_MAX_PAGES_PER_READ}-page limit per request.`);
  }

  let images: ToolResultContentBlock[];
  try {
    images = await extractPdfPages(absPath, first, last, env, signal);
  } catch (err) {
    if (err instanceof PopplerMissingError) {
      return errorResult(
        'Cannot read PDF: poppler not found. Install it (macOS: `brew install poppler`, Debian/Ubuntu: `apt-get install poppler-utils`).',
      );
    }
    return errorResult(`Cannot read PDF: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (images.length === 0) return errorResult(`Cannot read PDF: no pages rendered for ${rawPath}.`);
  const header: ToolResultContentBlock = {
    type: 'text',
    text: `PDF: ${rawPath} — ${images.length} page${images.length === 1 ? '' : 's'}${pageCount ? ` of ${pageCount}` : ''} (pages ${first}-${first + images.length - 1})`,
  };
  return contentResult([header, ...images]);
}

class PopplerMissingError extends Error {}

async function getPdfPageCount(
  absPath: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<number | null | 'no-poppler'> {
  try {
    const { stdout } = await runBin('pdfinfo', [absPath], env, signal);
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : null;
  } catch (err) {
    if (err instanceof PopplerMissingError) return 'no-poppler';
    return null; // pdfinfo failed (encrypted/corrupt) — let pdftoppm surface the real error
  }
}

async function extractPdfPages(
  absPath: string,
  first: number,
  last: number,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<ToolResultContentBlock[]> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-pdf-'));
  try {
    const prefix = path.join(tmp, 'page');
    const args = ['-jpeg', '-r', String(PDF_DPI), '-f', String(first), '-l', String(last), absPath, prefix];
    await runBin('pdftoppm', args, env, signal);
    const files = (await fsp.readdir(tmp)).filter(f => f.endsWith('.jpg')).sort();
    const blocks: ToolResultContentBlock[] = [];
    for (const f of files) {
      const bytes = await fsp.readFile(path.join(tmp, f));
      blocks.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' });
    }
    return blocks;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function runBin(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, signal, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new PopplerMissingError(`${bin} not found`));
        return reject(new Error(stderr?.trim() || err.message));
      }
      resolve({ stdout, stderr });
    });
  });
}

function parsePageRange(pages: string): { first: number; last: number } | null {
  const s = pages.trim();
  const single = /^(\d+)$/.exec(s);
  if (single) {
    const n = parseInt(single[1], 10);
    return n >= 1 ? { first: n, last: n } : null;
  }
  const open = /^(\d+)-$/.exec(s);
  if (open) {
    const f = parseInt(open[1], 10);
    return f >= 1 ? { first: f, last: Infinity } : null;
  }
  const range = /^(\d+)-(\d+)$/.exec(s);
  if (range) {
    const f = parseInt(range[1], 10);
    const l = parseInt(range[2], 10);
    return f >= 1 && l >= f ? { first: f, last: l } : null;
  }
  return null;
}
