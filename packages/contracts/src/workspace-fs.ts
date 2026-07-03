/**
 * Workspace filesystem runtime — the single seam file tools depend on.
 *
 * Tools (read/write/edit/grep) call this interface and never touch the host
 * filesystem or the wire directly, so switching a workspace between local, OS-
 * sandboxed, and remote backends is a *runtime swap* (a different `WorkspaceFs`
 * implementation) rather than per-tool branching. Each implementation is
 * responsible for enforcing the workspace jail and its own safety semantics:
 *
 * - The local implementation resolves against the workspace root and performs
 *   `O_NOFOLLOW` opens + atomic temp+rename writes in-process.
 * - A remote implementation carries the operation over the wire; the server
 *   enforces the equivalent jail and no-follow write on its side.
 *
 * Semantics the caller can request (atomicity, mode, no-follow) are expressed on
 * the operation so each backend fulfills them in its own layer.
 */

export interface WorkspaceFileStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  /** POSIX permission bits (0o7777 masked); backends without modes report 0o644. */
  mode: number;
}

export interface WorkspaceDirEntry {
  name: string;
  isDirectory: boolean;
}

export interface WorkspaceWriteOptions {
  /** Permission bits for a newly written file (default 0o644). */
  mode?: number;
  /**
   * Replace the file atomically (write-then-rename) so readers never observe a
   * half-written file and a crash cannot leave a truncated file. Default true.
   */
  atomic?: boolean;
}

/**
 * File operations scoped to one workspace. All paths are interpreted relative to
 * the workspace root (absolute paths must stay inside it); implementations reject
 * anything escaping the root.
 */
export interface WorkspaceFs {
  /** Read a file's bytes. Rejects directories and out-of-root paths. */
  readFile(path: string): Promise<Uint8Array>;
  /** Create or replace a file (creating parent directories). */
  writeFile(path: string, data: Uint8Array, options?: WorkspaceWriteOptions): Promise<void>;
  /** Stat a path without following a final-component symlink. */
  stat(path: string): Promise<WorkspaceFileStat>;
  /** List a directory's immediate children. */
  readdir(path: string): Promise<WorkspaceDirEntry[]>;
}
