import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGrepTool, createGlobTool, createReadTool } from '../builtin/index.js';
import type { FileReadState, ToolContext } from '@dongkseo/contracts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-parity-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeContext(workdir: string, readFileState?: Map<string, FileReadState>): ToolContext {
  return {
    tenantId: 't',
    workdir,
    secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...(readFileState ? { readFileState } : {}),
  };
}

// Minimal single-page PDF with correct xref offsets — rendered by pdftoppm.
function minimalPdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  ];
  const stream = 'BT /F1 24 Tf 20 60 Td (Hello Nexora) Tj ET';
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = Buffer.from('%PDF-1.4\n', 'latin1');
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')]);
  });
  const xref = out.length;
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offs) tail += `${String(off).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.concat([out, Buffer.from(tail, 'latin1')]);
}

describe('grep — output modes & pagination', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const TODO = 1;\nconst todo2 = 2;');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'const TODO = 9;');
  });

  it('files_with_matches lists paths only', async () => {
    const r = await createGrepTool().execute('1', { pattern: 'TODO', output_mode: 'files_with_matches' }, makeContext(tmpDir));
    expect(r.type).toBe('text');
    if (r.type === 'text') {
      expect(r.text).toContain('a.ts');
      expect(r.text).toContain('b.ts');
      expect(r.text).not.toContain(':1:'); // no content lines in files mode
      expect(r.text).toMatch(/Found 2 files/);
    }
  });

  it('count reports per-file totals', async () => {
    const r = await createGrepTool().execute('1', { pattern: 'TODO', output_mode: 'count' }, makeContext(tmpDir));
    expect(r.type).toBe('text');
    if (r.type === 'text') {
      expect(r.text).toMatch(/Found 2 total occurrences across 2 files/);
    }
  });

  it('case-insensitive matches with -i', async () => {
    const r = await createGrepTool().execute('1', { pattern: 'todo', '-i': true, output_mode: 'count' }, makeContext(tmpDir));
    expect(r.type).toBe('text');
    if (r.type === 'text') expect(r.text).toMatch(/Found 3 total occurrences/); // TODO×2 + todo2×1
  });

  it('head_limit + offset paginate content', async () => {
    const r1 = await createGrepTool().execute('1', { pattern: 'TODO', output_mode: 'content', head_limit: 1 }, makeContext(tmpDir));
    expect(r1.type).toBe('text');
    if (r1.type === 'text') {
      const body = r1.text.split('\n\n[pagination')[0];
      expect(body.split('\n').filter(Boolean).length).toBe(1);
      expect(r1.text).toContain('[pagination: limit 1]');
    }
  });

  it('content is the default mode (matching lines)', async () => {
    const r = await createGrepTool().execute('1', { pattern: 'TODO' }, makeContext(tmpDir));
    expect(r.type).toBe('text');
    if (r.type === 'text') expect(r.text).toMatch(/a\.ts:1:.*TODO/);
  });
});

// Regression: under the sandbox (ctx.workspace.run), the runtime serializes the
// engine argv through a shell, and sandbox-runtime escapes '!' to '\!'. A leading
// '!' --glob is ripgrep's *exclusion* syntax, but '\!' reads as a literal-'!'
// *include* glob that matches nothing — so every grep returned "No matches found".
// The plain execFile path (above) has no shell, so it never caught this. This
// context faithfully replays the '!' -> '\!' mangling against real ripgrep.
function makeSandboxLikeContext(workdir: string): ToolContext {
  return {
    tenantId: 't',
    workdir,
    secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    workspace: {
      resolve: async (rawPath: string) => ({ path: rawPath, root: workdir }),
      run: async ({ argv, cwd, env, signal }) => {
        // Replicate @anthropic-ai/sandbox-runtime's '!' escaping leak.
        const mangled = argv.map(a => a.replace(/!/g, '\\!'));
        return await new Promise(resolve => {
          execFile(
            mangled[0]!,
            mangled.slice(1),
            { cwd, env, signal, maxBuffer: 16 * 1024 * 1024 },
            (err, stdout) => resolve({
              stdout: stdout ?? '',
              stderr: '',
              exitCode: err ? (err.code ?? 1) : 0,
              signal: err?.signal ?? null,
              timedOut: false,
              aborted: false,
            }),
          );
        });
      },
    } as unknown as ToolContext['workspace'],
  };
}

describe('grep — sandbox/shell-wrapped run (! glob escaping)', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmpDir, 'MessageService.java'),
      'package x;\npublic class MessageService {\n  public void send() {}\n}\n');
  });

  it('finds matches even when the sandbox escapes "!" in VCS-exclude globs', async () => {
    const r = await createGrepTool().execute('1',
      { pattern: 'public.*Service', output_mode: 'content' },
      makeSandboxLikeContext(tmpDir));
    expect(r.type).toBe('text');
    if (r.type === 'text') {
      expect(r.text).not.toBe('No matches found.');
      expect(r.text).toMatch(/MessageService\.java:2:.*public class MessageService/);
    }
  });

  it('searches a subdirectory path under the sandbox', async () => {
    const sub = path.join(tmpDir, 'src', 'main', 'java');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'ChatService.java'), 'public interface ChatService {}\n');
    const r = await createGrepTool().execute('1',
      { pattern: 'public.*Service', output_mode: 'files_with_matches', path: 'src/main/java' },
      makeSandboxLikeContext(tmpDir));
    expect(r.type).toBe('text');
    if (r.type === 'text') expect(r.text).toContain('ChatService.java');
  });
});

describe('glob — sandbox/shell-wrapped run (backend-agnostic via workspace.run)', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmpDir, 'MessageService.java'), 'class X {}\n');
    const sub = path.join(tmpDir, 'src', 'main', 'java');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'ChatService.java'), 'interface Y {}\n');
  });

  it('lists files through the workspace.run seam (not local execFile)', async () => {
    const r = await createGlobTool().execute('1',
      { pattern: '**/*.java' },
      makeSandboxLikeContext(tmpDir));
    // glob is ripgrep-only; skip if rg is unavailable in this environment.
    if (r.type === 'error' && /ripgrep/i.test(r.message)) return;
    expect(r.type).toBe('text');
    if (r.type === 'text') {
      expect(r.text).not.toBe('No files found.');
      expect(r.text).toContain('MessageService.java');
      expect(r.text).toContain('ChatService.java');
    }
  });

  it('scopes to a subdirectory path under the sandbox', async () => {
    const r = await createGlobTool().execute('1',
      { pattern: '*.java', path: 'src/main/java' },
      makeSandboxLikeContext(tmpDir));
    if (r.type === 'error' && /ripgrep/i.test(r.message)) return;
    expect(r.type).toBe('text');
    if (r.type === 'text') {
      expect(r.text).toContain('ChatService.java');
      expect(r.text).not.toContain('MessageService.java');
    }
  });
});

describe('read — dedup, not-found, notebook, pdf', () => {
  it('dedups an unchanged re-read via readFileState', async () => {
    fs.writeFileSync(path.join(tmpDir, 'x.txt'), 'hello\nworld');
    const state = new Map<string, FileReadState>();
    const ctx = makeContext(tmpDir, state);
    const first = await createReadTool().execute('1', { path: 'x.txt' }, ctx);
    expect(first.type).toBe('text');
    if (first.type === 'text') expect(first.text).toContain('hello');

    const second = await createReadTool().execute('2', { path: 'x.txt' }, ctx);
    expect(second.type).toBe('text');
    if (second.type === 'text') expect(second.text).toContain('unchanged');
  });

  it('re-reads after the file changes on disk', async () => {
    const p = path.join(tmpDir, 'y.txt');
    fs.writeFileSync(p, 'v1');
    const state = new Map<string, FileReadState>();
    const ctx = makeContext(tmpDir, state);
    await createReadTool().execute('1', { path: 'y.txt' }, ctx);
    // bump mtime + content
    fs.writeFileSync(p, 'v2-changed');
    const again = await createReadTool().execute('2', { path: 'y.txt' }, ctx);
    expect(again.type).toBe('text');
    if (again.type === 'text') expect(again.text).toContain('v2-changed');
  });

  it('suggests a similar file on not-found', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.ts'), 'x');
    const r = await createReadTool().execute('1', { path: 'foo.tsx' }, makeContext(tmpDir));
    expect(r.type).toBe('error');
    if (r.type === 'error') expect(r.message).toContain('Did you mean foo.ts');
  });

  it('reads a notebook as text + output images', async () => {
    const nb = {
      cells: [
        { cell_type: 'code', source: ['print("hi")'], outputs: [
          { output_type: 'stream', text: ['hi\n'] },
          { output_type: 'display_data', data: { 'image/png': 'aGVsbG8=' } },
        ] },
        { cell_type: 'markdown', source: ['# Title'] },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'nb.ipynb'), JSON.stringify(nb));
    const r = await createReadTool().execute('1', { path: 'nb.ipynb' }, makeContext(tmpDir));
    expect(r.type).toBe('content');
    if (r.type === 'content') {
      const text = r.blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
      expect(text).toContain('print("hi")');
      expect(text).toContain('# Title');
      expect(r.blocks.some(b => b.type === 'image')).toBe(true);
    }
  });

  it('renders PDF pages to images via poppler', async () => {
    fs.writeFileSync(path.join(tmpDir, 'doc.pdf'), minimalPdf());
    const r = await createReadTool().execute('1', { path: 'doc.pdf' }, makeContext(tmpDir));
    if (r.type === 'error' && /poppler not found/i.test(r.message)) {
      return; // poppler not installed in this environment — skip
    }
    expect(r.type).toBe('content');
    if (r.type === 'content') {
      expect(r.blocks.some(b => b.type === 'image' && b.mimeType === 'image/jpeg')).toBe(true);
    }
  });
});
