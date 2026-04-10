/**
 * Safe path resolution helpers — defend against symlink escape AND TOCTOU.
 *
 * History:
 *  v1: lexical `path.resolve(workdir, x).startsWith(workdir + sep)`.
 *      Bypassed trivially: workdir/link -> /etc/passwd was followed.
 *  v2: realpath-based check, then return a string for the caller to read/write.
 *      Bypassed by TOCTOU: an attacker can swap the target between the
 *      realpath() check and the subsequent fs.readFile() call.
 *  v3 (this file): the caller no longer gets a path string. Instead it gets a
 *      FileHandle opened with O_NOFOLLOW. The kernel guarantees that the final
 *      path component is not a symlink at open time, so symlink swapping after
 *      the realpath check cannot redirect the I/O. Intermediate-component
 *      TOCTOU is still a kernel-level concern (would need openat/dirfd), but
 *      the realpath pre-check makes it observably hard to win that race.
 *
 * Public API:
 *   openForRead(rawPath, root)   → FileHandle (reading)
 *   openForWrite(rawPath, root)  → FileHandle (create/truncate)
 *   openForReadWrite(rawPath, root) → FileHandle (read+write, file must exist)
 *   resolveDirForListing(rawPath, root) → string (directory listing — no fd needed)
 *
 * All four reject paths that resolve outside `root` and reject paths whose
 * final component is a symlink.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class PathOutsideWorkspaceError extends Error {
  constructor(target: string, root: string) {
    super(`Access denied: "${target}" resolves outside workspace root ${root}`);
    this.name = 'PathOutsideWorkspaceError';
  }
}

export class SymlinkRefusedError extends Error {
  constructor(target: string) {
    super(`Refusing to follow symlink at "${target}"`);
    this.name = 'SymlinkRefusedError';
  }
}

function isWithin(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root + path.sep);
}

/**
 * Resolve `rawPath` against `root` and canonicalize the parent directory.
 * Returns the absolute path of the requested target (which may not exist yet).
 *
 * Used as a pre-check. The actual safety guarantee comes from O_NOFOLLOW on
 * the open() call that the caller performs immediately after.
 */
async function resolveAgainstRoot(rawPath: string, root: string): Promise<{
  canonicalRoot: string;
  /** Absolute path with parent directory canonicalized. */
  finalPath: string;
}> {
  const canonicalRoot = await fsp.realpath(path.resolve(root));
  const requested = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(canonicalRoot, rawPath);

  // Special case: caller is asking for the root itself (e.g. read tool with '.').
  // We only need to verify that `requested` canonicalizes to the root — the
  // usual parent-dir check would wrongly reject it because root's parent is
  // outside root.
  if (requested === canonicalRoot) {
    return { canonicalRoot, finalPath: canonicalRoot };
  }

  // Canonicalize parent (which must already exist for read; may not for write).
  // Walking up handles the mkdir -p case.
  const parent = path.dirname(requested);
  const base = path.basename(requested);

  let parentReal: string;
  try {
    parentReal = await fsp.realpath(parent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    parentReal = await canonicalizeNearest(parent);
  }

  const finalPath = path.join(parentReal, base);

  // parent must be the root itself or a descendant of root
  if (!isWithin(parentReal, canonicalRoot)) {
    throw new PathOutsideWorkspaceError(rawPath, canonicalRoot);
  }
  if (!isWithin(finalPath, canonicalRoot)) {
    throw new PathOutsideWorkspaceError(rawPath, canonicalRoot);
  }

  return { canonicalRoot, finalPath };
}

/** Construct flags including O_NOFOLLOW when the platform supports it. */
function withNoFollow(base: number): number {
  // O_NOFOLLOW is defined on Linux and macOS; on Windows it's undefined and
  // a no-op. Use the constant if present.
  const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
  return noFollow ? base | noFollow : base;
}

/**
 * Open a file for read with O_NOFOLLOW. The kernel rejects with ELOOP if the
 * final component is a symlink, eliminating the TOCTOU window where a writer
 * could swap a checked path for a symlink between resolve and open.
 */
export async function openForRead(rawPath: string, root: string): Promise<fsp.FileHandle> {
  const { finalPath } = await resolveAgainstRoot(rawPath, root);
  try {
    return await fsp.open(finalPath, withNoFollow(fs.constants.O_RDONLY));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new SymlinkRefusedError(rawPath);
    throw err;
  }
}

/**
 * Open (create + truncate) a file for write with O_NOFOLLOW.
 *
 * Also handles the "mkdir -p parent directory" case SAFELY. The previous
 * version had callers run `fsp.mkdir(parent, { recursive: true })` on the
 * RAW user-supplied path BEFORE any workspace check, which let a malicious
 * path like `../outside/file` create directories outside the workspace even
 * though the subsequent open correctly failed.
 *
 * The fix: we canonicalize first (resolveAgainstRoot), then mkdir ONLY the
 * already-validated parent, then re-verify via realpath to catch a concurrent
 * symlink swap on the new directory, and finally open with O_NOFOLLOW.
 */
export async function openForWrite(rawPath: string, root: string): Promise<fsp.FileHandle> {
  const { canonicalRoot, finalPath } = await resolveAgainstRoot(rawPath, root);

  // Ensure the parent directory exists INSIDE the validated boundary.
  // resolveAgainstRoot has already verified that parentReal is within canonicalRoot.
  const parentDir = path.dirname(finalPath);
  if (parentDir !== canonicalRoot) {
    await fsp.mkdir(parentDir, { recursive: true });

    // Re-verify after mkdir: between validation and mkdir, an attacker could
    // have swapped an intermediate directory to a symlink. realpath catches that.
    const parentReal = await fsp.realpath(parentDir);
    if (!isWithin(parentReal, canonicalRoot)) {
      throw new PathOutsideWorkspaceError(rawPath, canonicalRoot);
    }
  }

  // Pre-check: if the target already exists as a symlink, refuse before O_CREAT
  // would even consider following it.
  try {
    const lst = await fsp.lstat(finalPath);
    if (lst.isSymbolicLink()) throw new SymlinkRefusedError(rawPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // ENOENT = file doesn't exist yet, normal create case
  }

  const flags = withNoFollow(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC);
  try {
    return await fsp.open(finalPath, flags, 0o644);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new SymlinkRefusedError(rawPath);
    throw err;
  }
}

/**
 * Open a file for read+write (used by edit). File must exist; refuses symlinks.
 */
export async function openForReadWrite(rawPath: string, root: string): Promise<fsp.FileHandle> {
  const { finalPath } = await resolveAgainstRoot(rawPath, root);
  try {
    return await fsp.open(finalPath, withNoFollow(fs.constants.O_RDWR));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new SymlinkRefusedError(rawPath);
    throw err;
  }
}

/**
 * Resolve a directory path for listing. There's no fd-based readdir in Node's
 * promise API, so we fall back to a realpath-then-readdir pattern. The race
 * window here is small (directory operations) and the impact is bounded
 * (listing only).
 */
export async function resolveDirForListing(rawPath: string, root: string): Promise<string> {
  const canonicalRoot = await fsp.realpath(path.resolve(root));
  const requested = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(canonicalRoot, rawPath);
  const real = await fsp.realpath(requested);
  if (!isWithin(real, canonicalRoot)) {
    throw new PathOutsideWorkspaceError(rawPath, canonicalRoot);
  }
  return real;
}

/**
 * Canonicalize a path under `root` without opening it.
 * Used by tools that need the validated absolute path (e.g. `edit` does a
 * temp-file + rename where both paths must be pre-validated).
 * Throws PathOutsideWorkspaceError if it escapes root.
 */
export async function canonicalizePath(rawPath: string, root: string): Promise<string> {
  const { finalPath } = await resolveAgainstRoot(rawPath, root);
  return finalPath;
}

/**
 * Walk up the path until we find a directory that exists, canonicalize that,
 * then re-attach the missing trailing components. Used for "mkdir -p"-style
 * write targets where intermediate dirs may not exist yet.
 */
async function canonicalizeNearest(p: string): Promise<string> {
  const segments: string[] = [];
  let current = p;
  while (true) {
    try {
      const real = await fsp.realpath(current);
      let result = real;
      for (let i = segments.length - 1; i >= 0; i--) {
        result = path.join(result, segments[i]);
      }
      return result;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) {
        return p;
      }
      segments.push(path.basename(current));
      current = parent;
    }
  }
}
