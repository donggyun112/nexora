import { describe, it, expect } from 'vitest';
import type {
  ResolvedWorkspacePath,
  ToolContext,
  ToolResult,
  WorkspaceDirEntry,
  WorkspaceFileStat,
  WorkspaceFs,
  WorkspaceResolveOptions,
  WorkspaceSession,
  WorkspaceWriteOptions,
} from '@dongkseo/contracts';
import { createReadTool } from '../builtin/read.js';
import { createWriteTool } from '../builtin/write.js';
import { createEditTool } from '../builtin/edit.js';

/** In-memory remote-like workspace: exposes a WorkspaceFs, no local filesystem. */
class MemFs implements WorkspaceFs {
  readonly files = new Map<string, Buffer>();

  private norm(p: string): string {
    const rel = p.startsWith('/workspace/') ? p.slice('/workspace/'.length) : p;
    if (rel.split('/').includes('..')) throw new Error('resolves outside workspace root /workspace');
    return rel;
  }

  async readFile(p: string): Promise<Uint8Array> {
    const buf = this.files.get(this.norm(p));
    if (!buf) {
      const err = new Error(`no such file: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return buf;
  }

  async writeFile(p: string, data: Uint8Array, _options?: WorkspaceWriteOptions): Promise<void> {
    this.files.set(this.norm(p), Buffer.from(data));
  }

  async stat(p: string): Promise<WorkspaceFileStat> {
    const buf = this.files.get(this.norm(p));
    if (!buf) {
      const err = new Error(`no such file: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return { size: buf.length, mtimeMs: 0, isFile: true, isDirectory: false, mode: 0o644 };
  }

  async readdir(_p: string): Promise<WorkspaceDirEntry[]> {
    return [];
  }
}

class MemWorkspace implements WorkspaceSession {
  readonly id = 'mem';
  readonly root = '/workspace';
  readonly mode = 'workspace-write' as const;
  readonly mounts = [];
  readonly fs = new MemFs();

  async resolve(rawPath: string, options: WorkspaceResolveOptions = {}): Promise<ResolvedWorkspacePath> {
    if (rawPath.split('/').includes('..')) {
      throw new Error(`Access denied: "${rawPath}" resolves outside workspace root ${this.root}`);
    }
    const write = options.access === 'write' || options.access === 'readwrite';
    return { path: `${this.root}/${rawPath}`, root: this.root, relativePath: rawPath, access: write ? 'rw' : 'ro' };
  }

  async cleanup(): Promise<void> {}
}

function ctxWith(ws: MemWorkspace): ToolContext {
  return {
    tenantId: 't',
    workdir: '/workspace',
    workspace: ws,
    secrets: { get: async () => undefined },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as ToolContext;
}

describe('builtin fs tools over a remote workspace (WorkspaceFs seam)', () => {
  it('write routes through the workspace fs', async () => {
    const ws = new MemWorkspace();
    const res = (await createWriteTool().execute('1', { path: 'a.txt', content: 'hello' }, ctxWith(ws))) as Extract<
      ToolResult,
      { type: 'text' }
    >;
    expect(res.type).toBe('text');
    expect(ws.fs.files.get('a.txt')?.toString('utf8')).toBe('hello');
  });

  it('read returns numbered text fetched via the workspace fs', async () => {
    const ws = new MemWorkspace();
    ws.fs.files.set('note.txt', Buffer.from('line1\nline2'));
    const res = (await createReadTool().execute('1', { path: 'note.txt' }, ctxWith(ws))) as Extract<
      ToolResult,
      { type: 'text' }
    >;
    expect(res.type).toBe('text');
    expect(res.text).toContain('     1→line1');
    expect(res.text).toContain('     2→line2');
  });

  it('read of a missing file returns a not-found error', async () => {
    const ws = new MemWorkspace();
    const res = (await createReadTool().execute('1', { path: 'ghost.txt' }, ctxWith(ws))) as Extract<
      ToolResult,
      { type: 'error' }
    >;
    expect(res.type).toBe('error');
    expect(res.message.toLowerCase()).toContain('not found');
  });

  it('edit does read-modify-write through the workspace fs', async () => {
    const ws = new MemWorkspace();
    ws.fs.files.set('code.ts', Buffer.from('const x = 1;\nconst y = 2;'));
    const res = (await createEditTool().execute(
      '1',
      { path: 'code.ts', old_string: 'const x = 1;', new_string: 'const x = 42;' },
      ctxWith(ws),
    )) as Extract<ToolResult, { type: 'text' }>;
    expect(res.text).toContain('Replaced 1 occurrence');
    expect(ws.fs.files.get('code.ts')?.toString('utf8')).toBe('const x = 42;\nconst y = 2;');
  });

  it('edit rejects a non-unique old_string without replace_all', async () => {
    const ws = new MemWorkspace();
    ws.fs.files.set('dup.txt', Buffer.from('a\na\n'));
    const res = (await createEditTool().execute(
      '1',
      { path: 'dup.txt', old_string: 'a', new_string: 'b' },
      ctxWith(ws),
    )) as Extract<ToolResult, { type: 'error' }>;
    expect(res.message).toContain('appears 2 times');
  });

  it('rejects a path escaping the workspace root', async () => {
    const ws = new MemWorkspace();
    const res = (await createWriteTool().execute(
      '1',
      { path: '../escape.txt', content: 'x' },
      ctxWith(ws),
    )) as Extract<ToolResult, { type: 'error' }>;
    expect(res.message.toLowerCase()).toContain('outside workspace root');
  });
});
