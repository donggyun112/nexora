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

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SnapshotBackend } from '@dongkseo/contracts';
import { safeExtractTar, writeTar } from '@dongkseo/contracts';

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
 *
 * Archives are produced and consumed with the dependency-free safe-archive
 * layer (`writeTar` / `safeExtractTar`) rather than the system `tar` binary, so
 * restore validates every member (traversal, unsafe symlinks, hardlinks,
 * resource bombs) and extracts with `O_NOFOLLOW` instead of trusting the bytes.
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
      const archive = await writeTar(rootDir);
      await fsp.writeFile(tmp, archive, { mode: 0o600 });
      await fsp.rename(tmp, target);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    return target;
  }

  async restore(ref: string, destDir: string): Promise<void> {
    const archive = await fsp.readFile(ref);
    await safeExtractTar(archive, destDir);
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

/**
 * Deterministic SHA256 fingerprint of a directory tree's contents. Walks every
 * regular file (sorted by relative path) and folds each path + bytes into one
 * digest, so the result changes iff any file is added, removed, or modified.
 * Drives the hot path on resume (live root unchanged → skip restore).
 *
 * v1 is a full-content hash with no exclusions; see design 9.2 for lighter
 * alternatives (mtime+size, exclude patterns) once workspaces grow large.
 */
export async function fingerprintRoot(dir: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const files = await collectFilesRelative(dir, dir);
  files.sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await fsp.readFile(path.join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function collectFilesRelative(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out; // missing dir → empty fingerprint contribution
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFilesRelative(root, abs)));
    } else if (entry.isFile()) {
      out.push(path.relative(root, abs));
    }
  }
  return out;
}
