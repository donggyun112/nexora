/**
 * LocalWorkspaceFs — the local filesystem runtime behind the `WorkspaceFs` seam.
 *
 * This is where the host-filesystem safety logic lives so that file tools do not
 * carry it (or any local-vs-remote branching) themselves: `O_NOFOLLOW` opens to
 * refuse final-component symlink swaps, root-jail resolution, atomic temp+rename
 * writes, and permission-bit preservation. A remote backend provides a different
 * `WorkspaceFs` that enforces the same guarantees server-side; tools call the
 * interface either way.
 *
 * See `safe-path.ts` for the full threat model (intermediate-component TOCTOU
 * remains a best-effort boundary — run under an OS sandbox for untrusted input).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  WorkspaceDirEntry,
  WorkspaceFileStat,
  WorkspaceFs,
  WorkspaceWriteOptions,
} from '@dongkseo/contracts';
import {
  openForRead,
  openForWrite,
  canonicalizePath,
  resolveDirForListing,
} from './safe-path.js';

class LocalWorkspaceFs implements WorkspaceFs {
  constructor(private readonly root: string) {}

  async readFile(filePath: string): Promise<Uint8Array> {
    const handle = await openForRead(filePath, this.root);
    try {
      return await handle.readFile();
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async stat(filePath: string): Promise<WorkspaceFileStat> {
    const handle = await openForRead(filePath, this.root);
    try {
      const s = await handle.stat();
      return {
        size: s.size,
        mtimeMs: s.mtimeMs,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        mode: s.mode & 0o7777,
      };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async readdir(dirPath: string): Promise<WorkspaceDirEntry[]> {
    const dir = await resolveDirForListing(dirPath, this.root);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  }

  async writeFile(filePath: string, data: Uint8Array, options: WorkspaceWriteOptions = {}): Promise<void> {
    const mode = options.mode;
    const atomic = options.atomic ?? true;
    if (!atomic) {
      const handle = await openForWrite(filePath, this.root);
      try {
        await handle.writeFile(Buffer.from(data));
        if (mode !== undefined) await handle.chmod(mode);
      } finally {
        await handle.close().catch(() => {});
      }
      return;
    }

    // Atomic replace: write a sibling temp file (validated inside the root), then
    // rename over the target. rename(2) is atomic on POSIX and does not follow a
    // symlink at the target — a swapped target is overwritten, not traversed.
    const target = await canonicalizePath(filePath, this.root);
    const dir = path.dirname(target);
    const tempName = `.${path.basename(target)}.nexora-${randomBytes(6).toString('hex')}.tmp`;
    const tempRaw = path.join(dir, tempName);
    const handle = await openForWrite(tempRaw, this.root);
    let tempPath: string;
    try {
      await handle.writeFile(Buffer.from(data));
      if (mode !== undefined) await handle.chmod(mode);
      await handle.sync().catch(() => {});
      tempPath = await canonicalizePath(tempRaw, this.root);
    } catch (err) {
      await handle.close().catch(() => {});
      await removeQuietly(tempRaw, this.root);
      throw err;
    }
    await handle.close().catch(() => {});
    try {
      await fsp.rename(tempPath, target);
    } catch (err) {
      await removeQuietly(tempRaw, this.root);
      throw err;
    }
  }
}

async function removeQuietly(rawPath: string, root: string): Promise<void> {
  try {
    const p = await canonicalizePath(rawPath, root);
    await fsp.unlink(p).catch(() => {});
  } catch {
    // best-effort
  }
}

/** Build a `WorkspaceFs` backed by the host filesystem, jailed to `root`. */
export function createLocalWorkspaceFs(root: string): WorkspaceFs {
  return new LocalWorkspaceFs(root);
}
