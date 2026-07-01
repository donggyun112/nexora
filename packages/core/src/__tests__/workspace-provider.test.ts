import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostWorkspaceProvider } from '../workspace-provider.js';

describe('HostWorkspaceProvider', () => {
  it('creates and cleans up per-run workspace directories', async () => {
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-ws-test-'));
    try {
      const provider = new HostWorkspaceProvider({
        baseDir,
        perRun: true,
        cleanup: 'delete',
      });

      const workspace = await provider.acquire({ runId: 'run/1' });
      await fsp.writeFile(path.join(workspace.root, 'artifact.txt'), 'ok', 'utf-8');
      const root = workspace.root;

      expect(root.startsWith(baseDir)).toBe(true);
      await expect(fsp.readFile(path.join(root, 'artifact.txt'), 'utf-8')).resolves.toBe('ok');

      await workspace.cleanup();
      await expect(fsp.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the workspace root', async () => {
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-ws-test-'));
    try {
      const provider = new HostWorkspaceProvider({ root: baseDir });
      const workspace = await provider.acquire();

      await expect(workspace.resolve('../outside.txt')).rejects.toThrow(/outside workspace root/);
    } finally {
      await fsp.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('rejects symlink escapes from the workspace root', async () => {
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-ws-test-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-ws-outside-'));
    try {
      await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf-8');
      await fsp.symlink(outside, path.join(baseDir, 'link-out'));
      const provider = new HostWorkspaceProvider({ root: baseDir });
      const workspace = await provider.acquire();

      await expect(workspace.resolve('link-out/secret.txt')).rejects.toThrow(/outside workspace root/);
    } finally {
      await fsp.rm(baseDir, { recursive: true, force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('fails closed when no reusable root is provided', async () => {
    const provider = new HostWorkspaceProvider();

    await expect(provider.acquire()).rejects.toThrow(/requires root, baseWorkdir, or perRun/);
  });

  it('materializes seedDirs into the acquired root', async () => {
    const seedSource = await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-src-'));
    try {
      await fsp.writeFile(path.join(seedSource, 'SKILL.md'), '# seeded');

      const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-ws-'));
      try {
        const provider = new HostWorkspaceProvider({ baseDir, perRun: true });
        const session = await provider.acquire({
          seedDirs: [{ source: seedSource, destSubpath: '.skill_refs' }],
        });

        const seeded = await fsp.readFile(path.join(session.root, '.skill_refs', 'SKILL.md'), 'utf-8');
        expect(seeded).toBe('# seeded');
      } finally {
        await fsp.rm(baseDir, { recursive: true, force: true });
      }
    } finally {
      await fsp.rm(seedSource, { recursive: true, force: true });
    }
  });
});
