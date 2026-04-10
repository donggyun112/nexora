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
 *      the realpath check cannot redirect the I/O.
 *
 * ============================================================================
 * THREAT MODEL & KNOWN LIMITATIONS (read this before trusting the tool):
 *
 *  1. Final-component symlink swap — CLOSED.
 *     O_NOFOLLOW on the final open() rejects with ELOOP if the target is a
 *     symlink at open time, even if it wasn't when we validated the path.
 *
 *  2. Intermediate-directory symlink race — FUNDAMENTALLY OPEN.
 *     This is the hardest piece to reason about honestly. A previous version
 *     of these docs claimed this was "closed in practice" for the open path
 *     and only open for the mkdir path. That was an overclaim. BOTH paths
 *     share the same limitation, because `fsp.open(finalPath)` and
 *     `fsp.mkdir(parentDir)` both walk the path string component by component,
 *     and the kernel follows symlinks at every intermediate component except
 *     the last (which is what O_NOFOLLOW protects).
 *
 *     The attack model: between `resolveAgainstRoot()` validating the path
 *     and the actual `open()`/`mkdir()` syscall, an attacker who can win a
 *     same-host filesystem race can swap an intermediate directory for a
 *     symlink to outside the workspace root. On the next syscall, the kernel
 *     traverses through the swapped symlink.
 *
 *     Consequences by path:
 *       - `openForRead` / `openForReadWrite`: reading through a swapped
 *         intermediate symlink could return data from outside the workspace.
 *         Impact: DATA READ leak is possible if the attacker wins the race.
 *       - `openForWrite`: the `mkdir -p` step can create directories outside
 *         the workspace, AND the final `open(..., O_CREAT | O_TRUNC)` could
 *         traverse through a swapped intermediate and create/truncate a file
 *         outside the workspace. Impact: DATA WRITE leak is possible if the
 *         attacker wins the race.
 *
 *     The only complete fix is dirfd-based traversal via openat(2)/mkdirat(2):
 *     open the validated parent as a file descriptor, then use `*at` syscalls
 *     relative to that dirfd so the kernel never re-traverses the path string.
 *     Node.js does NOT expose these syscalls through `fs.promises` or any
 *     public API. There is no way to eliminate this race in pure JavaScript.
 *
 *     Mitigations in this file (best-effort only):
 *       - Pre-validation via `realpath` narrows the race window to the time
 *         between that check and the follow-up syscall (single microtask).
 *       - For the write path, we also re-canonicalize via realpath AFTER
 *         `mkdir` and raise `PathOutsideWorkspaceError` if the directory
 *         ended up outside the root. The side effect (the stray mkdir) has
 *         already happened by the time we detect it, but a subsequent file
 *         open through that directory would also be caught by the same
 *         post-check before we return a FileHandle to the caller.
 *       - `O_NOFOLLOW` on the final component still protects against the
 *         simpler "symlink AT the target" class of attack.
 *
 *     Bottom line: if your workspace root sits on a filesystem where an
 *     attacker can create files (e.g. a shared tmpdir, a network mount you
 *     don't fully control, a chroot with loose permissions), you CANNOT rely
 *     on these helpers for full isolation. Run Nexora inside an OS-level
 *     sandbox (bubblewrap, nsjail, a per-tenant container with its own mount
 *     namespace, etc.) where the attacker simply has no filesystem presence
 *     inside the root to race against. The in-process defense is best-effort.
 * ============================================================================
 *
 * Public API:
 *   openForRead(rawPath, root)   → FileHandle (reading)
 *   openForWrite(rawPath, root)  → FileHandle (create/truncate, mkdir -p parent)
 *   openForReadWrite(rawPath, root) → FileHandle (read+write, file must exist)
 *   resolveDirForListing(rawPath, root) → string (directory listing — no fd needed)
 *   canonicalizePath(rawPath, root) → string (validated abs path, no I/O)
 *
 * All reject paths that resolve outside `root` and reject paths whose
 * final component is a symlink (ELOOP → SymlinkRefusedError).
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
 * FINAL component is a symlink, eliminating the final-component TOCTOU window.
 *
 * NOTE: intermediate path components are still resolved by the kernel on each
 * syscall. An attacker winning a same-host race can swap an intermediate dir
 * for a symlink between validation and this open(), causing the read to return
 * data from outside the workspace. See the "FUNDAMENTALLY OPEN" entry in the
 * module docblock — this cannot be closed in pure Node.js (no openat).
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
 * Also handles the "mkdir -p parent directory" case. The previous version had
 * callers run `fsp.mkdir(parent, { recursive: true })` on the RAW user-supplied
 * path BEFORE any workspace check, which let a malicious path like
 * `../outside/file` create directories outside the workspace even though the
 * subsequent open correctly failed. That specific bug is now closed: we
 * canonicalize first, then mkdir only the already-validated parent, then
 * re-verify via realpath and raise PathOutsideWorkspaceError on mismatch.
 *
 * KNOWN LIMITATION — intermediate-component TOCTOU:
 *   Both the mkdir() and the subsequent open() walk the path string and let
 *   the kernel resolve each intermediate component. An attacker winning a
 *   same-host filesystem race between our realpath validation and these
 *   syscalls can swap an intermediate directory for a symlink that points
 *   outside the workspace root. Consequences:
 *
 *     - mkdir can create a stray directory outside the root (post-check
 *       catches the state AFTER the fact and turns the silent escape into
 *       a loud error, but the directory has already been created).
 *     - open(..., O_CREAT|O_TRUNC) can create or truncate a file outside
 *       the root if the swap happens at the right moment. O_NOFOLLOW only
 *       protects the FINAL path component, not intermediates.
 *
 *   This cannot be fixed in pure Node.js. fs.promises does not expose
 *   openat(2)/mkdirat(2), so there is no way to perform dirfd-anchored
 *   traversal that bypasses the kernel's component-by-component pathname
 *   resolution. Without a native addon, this race remains fundamentally open.
 *
 *   For untrusted input, run Nexora inside an OS-level sandbox (bubblewrap,
 *   nsjail, per-tenant container with its own mount namespace) where the
 *   attacker has no filesystem presence inside the workspace to race against.
 *   The in-process defense here is best-effort and should NOT be relied on
 *   as a hard boundary against co-located attackers.
 */
export async function openForWrite(rawPath: string, root: string): Promise<fsp.FileHandle> {
  const { canonicalRoot, finalPath } = await resolveAgainstRoot(rawPath, root);

  // Ensure the parent directory exists INSIDE the validated boundary.
  // resolveAgainstRoot has already verified that parentReal is within canonicalRoot.
  const parentDir = path.dirname(finalPath);
  if (parentDir !== canonicalRoot) {
    await fsp.mkdir(parentDir, { recursive: true });

    // Re-verify after mkdir: between validation and mkdir, an attacker could
    // have swapped an intermediate directory to a symlink. realpath catches that
    // and raises an error, but see the "KNOWN LIMITATION" note above — the mkdir
    // side effect has already happened by the time we get here.
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
 * Open a file for read+write (used by edit). File must exist; refuses
 * final-component symlinks via O_NOFOLLOW. Same intermediate-component TOCTOU
 * limitation as openForRead/openForWrite applies — see module docblock.
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
