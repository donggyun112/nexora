import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecTool } from '../builtin/exec.js';
import type { ToolContext } from '@dongkseo/contracts';

/**
 * Faithful workspace stub: `resolve()` enforces the same boundary the real
 * HostWorkspaceSession does — a relative cwd is joined onto root and rejected
 * if it escapes the root tree. `root` stays the jail; `resolve().path` is the
 * subdirectory the command actually runs in.
 */
function makeWorkspace(rootReal: string): { root: string; resolve: (rel: string) => Promise<{ path: string; root: string; relativePath: string; access: 'rw' }> } {
  return {
    root: rootReal,
    resolve: async (rel: string) => {
      const abs = path.resolve(rootReal, rel);
      if (abs !== rootReal && !abs.startsWith(rootReal + path.sep)) {
        throw new Error(`path "${rel}" escapes workspace root`);
      }
      return { path: abs, root: rootReal, relativePath: path.relative(rootReal, abs), access: 'rw' };
    },
  };
}

function ctxWith(workspace: unknown, workdir: string): ToolContext {
  return {
    tenantId: 't',
    workdir,
    workspace,
    secrets: { get: async () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as ToolContext;
}

describe('exec cwd parameter', () => {
  it('runs the command in a subdirectory of the workspace root when cwd is given', async () => {
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'exec-cwd-')));
    await fsp.mkdir(path.join(root, 'subdir'));
    const exec = createExecTool({ allowList: ['pwd'] });

    const res = await exec.execute(
      'c1',
      { argv: ['pwd'], cwd: 'subdir' },
      ctxWith(makeWorkspace(root), root),
    );

    expect(res.type).toBe('text');
    // pwd prints the physical cwd — proves the child started in root/subdir, not root.
    if (res.type === 'text') expect(res.text).toContain('subdir');

    await fsp.rm(root, { recursive: true, force: true });
  });

  it('rejects a cwd that escapes the workspace root (jail stays intact)', async () => {
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'exec-cwd-')));
    const exec = createExecTool({ allowList: ['pwd'] });

    const res = await exec.execute(
      'c2',
      { argv: ['pwd'], cwd: '../../etc' },
      ctxWith(makeWorkspace(root), root),
    );

    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/cwd|workspace|escape|outside/i);

    await fsp.rm(root, { recursive: true, force: true });
  });

  it('defaults cwd to the workspace root when cwd is omitted (existing behavior)', async () => {
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'exec-cwd-')));
    const exec = createExecTool({ allowList: ['pwd'] });

    const res = await exec.execute('c3', { argv: ['pwd'] }, ctxWith(makeWorkspace(root), root));

    expect(res.type).toBe('text');
    if (res.type === 'text') expect(res.text).toContain(path.basename(root));

    await fsp.rm(root, { recursive: true, force: true });
  });

  // No workspace (non-sandbox config): cwd is joined onto ctx.workdir, which is
  // then the boundary it must not escape.
  it('runs in a subdirectory relative to ctx.workdir when no workspace is present', async () => {
    const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'exec-cwd-')));
    await fsp.mkdir(path.join(base, 'subdir'));
    const exec = createExecTool({ allowList: ['pwd'] });

    const res = await exec.execute('c4', { argv: ['pwd'], cwd: 'subdir' }, ctxWith(undefined, base));

    expect(res.type).toBe('text');
    if (res.type === 'text') expect(res.text).toContain('subdir');

    await fsp.rm(base, { recursive: true, force: true });
  });

  it('rejects a cwd that escapes ctx.workdir when no workspace is present', async () => {
    const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'exec-cwd-')));
    const exec = createExecTool({ allowList: ['pwd'] });

    const res = await exec.execute('c5', { argv: ['pwd'], cwd: '../../etc' }, ctxWith(undefined, base));

    expect(res.type).toBe('error');
    if (res.type === 'error') expect(res.message).toMatch(/cwd|escape|outside|working directory/i);

    await fsp.rm(base, { recursive: true, force: true });
  });
});
