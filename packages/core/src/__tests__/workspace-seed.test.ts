import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { materializeSeedDirs } from '../workspace-seed.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('materializeSeedDirs', () => {
  it('copies a source directory into <root>/<destSubpath>', async () => {
    const source = await makeTempDir('seed-src-');
    await fsp.mkdir(path.join(source, 'my-skill'), { recursive: true });
    await fsp.writeFile(path.join(source, 'my-skill', 'SKILL.md'), '# hello');

    const root = await makeTempDir('seed-root-');
    await materializeSeedDirs(root, [{ source, destSubpath: 'skills' }]);

    const copied = await fsp.readFile(path.join(root, 'skills', 'my-skill', 'SKILL.md'), 'utf-8');
    expect(copied).toBe('# hello');
  });

  it('skips symlinks instead of following them', async () => {
    const source = await makeTempDir('seed-src-');
    const outside = await makeTempDir('seed-outside-');
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'do not copy');
    await fsp.symlink(path.join(outside, 'secret.txt'), path.join(source, 'link.txt'));
    await fsp.writeFile(path.join(source, 'real.txt'), 'copy me');

    const root = await makeTempDir('seed-root-');
    await materializeSeedDirs(root, [{ source, destSubpath: 'out' }]);

    await expect(fsp.access(path.join(root, 'out', 'link.txt'))).rejects.toThrow();
    const real = await fsp.readFile(path.join(root, 'out', 'real.txt'), 'utf-8');
    expect(real).toBe('copy me');
  });

  it('no-ops silently when the source directory does not exist', async () => {
    const root = await makeTempDir('seed-root-');
    await expect(
      materializeSeedDirs(root, [{ source: '/no/such/path', destSubpath: 'skills' }]),
    ).resolves.toBeUndefined();
    await expect(fsp.access(path.join(root, 'skills'))).rejects.toThrow();
  });

  it('no-ops when seedDirs is undefined or empty', async () => {
    const root = await makeTempDir('seed-root-');
    await expect(materializeSeedDirs(root, undefined)).resolves.toBeUndefined();
    await expect(materializeSeedDirs(root, [])).resolves.toBeUndefined();
  });

  it('re-copies on every call (overwrites stale content)', async () => {
    const source = await makeTempDir('seed-src-');
    await fsp.writeFile(path.join(source, 'a.txt'), 'v1');
    const root = await makeTempDir('seed-root-');

    await materializeSeedDirs(root, [{ source, destSubpath: 'out' }]);
    await fsp.writeFile(path.join(source, 'a.txt'), 'v2');
    await materializeSeedDirs(root, [{ source, destSubpath: 'out' }]);

    const content = await fsp.readFile(path.join(root, 'out', 'a.txt'), 'utf-8');
    expect(content).toBe('v2');
  });

  it('swallows fs errors during copy (unreadable source file) and resolves gracefully', async () => {
    const source = await makeTempDir('seed-src-');
    await fsp.mkdir(path.join(source, 'subdir'), { recursive: true });
    await fsp.writeFile(path.join(source, 'readable.txt'), 'ok');
    await fsp.writeFile(path.join(source, 'subdir', 'blocked.txt'), 'blocked');

    const root = await makeTempDir('seed-root-');

    // First, make the blocked file unreadable (triggers copy error on second attempt)
    await fsp.chmod(path.join(source, 'subdir', 'blocked.txt'), 0o000);

    try {
      // Attempt to copy with an unreadable file in the source.
      // The copy operation will fail partway through.
      // This must resolve without throwing (best-effort guarantee).
      await expect(
        materializeSeedDirs(root, [{ source, destSubpath: 'out' }]),
      ).resolves.toBeUndefined();
    } finally {
      // Restore permissions for cleanup
      await fsp.chmod(path.join(source, 'subdir', 'blocked.txt'), 0o644);
    }
  });
});
