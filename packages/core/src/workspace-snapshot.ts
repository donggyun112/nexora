/**
 * Workspace snapshot backends — durable persistence for layer ② (workspace
 * lifetime). A snapshot archives the whole workspace root so it survives tmpdir
 * loss and can be rehydrated into a fresh root on a later turn/host.
 *
 * Mirrors the reference SDK's snapshot model (persist / restore / restorable),
 * adapted to a dependency-free `tar`-based local backend. The backend is
 * orthogonal to the OS isolation engine: it works the same whether the runtime
 * is seatbelt, a container, or a plain host directory.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SnapshotBackend } from '@dongkseo/contracts';

/** Default backend: no durable persistence (caller falls back to inline-root). */
export class NoopSnapshotBackend implements SnapshotBackend {
  readonly kind = 'noop';

  async persist(): Promise<string> {
    return '';
  }

  async restore(): Promise<void> {
    /* nothing to restore */
  }

  async restorable(): Promise<boolean> {
    return false;
  }
}

/**
 * Local backend that archives the workspace as a `.tar` under `baseDir`.
 * Portable across runs and host restarts; not across machines (use a remote
 * backend for that).
 */
export class LocalTarSnapshotBackend implements SnapshotBackend {
  readonly kind = 'local-tar';

  constructor(private readonly baseDir: string) {}

  async persist(snapshotId: string, rootDir: string): Promise<string> {
    const target = path.join(this.baseDir, `${snapshotSegment(snapshotId)}.tar`);
    await fsp.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(
      this.baseDir,
      `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
    );
    try {
      // `-C rootDir .` keeps archived paths relative to the workspace root.
      await runTar(['-cf', tmp, '-C', rootDir, '.']);
      await fsp.rename(tmp, target);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    return target;
  }

  async restore(ref: string, destDir: string): Promise<void> {
    await fsp.mkdir(destDir, { recursive: true, mode: 0o700 });
    await runTar(['-xf', ref, '-C', destDir]);
  }

  async restorable(ref: string): Promise<boolean> {
    try {
      const stat = await fsp.stat(ref);
      return stat.isFile();
    } catch {
      return false;
    }
  }
}

/** Reject ids that are not a single safe path segment (mirrors reference). */
function snapshotSegment(id: string): string {
  const base = path.basename(id);
  if (id === '' || id === '.' || id === '..' || id !== base || id.includes('/')) {
    throw new Error(`snapshot id must be a single path segment, got: ${JSON.stringify(id)}`);
  }
  return id;
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar ${args[0]} failed (code ${code}): ${stderr.trim()}`));
    });
  });
}
