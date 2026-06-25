/**
 * Workspace runtime boundary.
 *
 * A WorkspaceSession is the directory-level execution boundary that tools should
 * use for file and process access. The default host implementation is still a
 * best-effort filesystem boundary; stronger providers can back this contract
 * with containers, mount namespaces, or remote sandboxes.
 */

export type WorkspaceAccessMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type WorkspaceMountAccess = 'ro' | 'rw';

export type WorkspaceMountKind = 'workspace' | 'reference' | 'scratch' | 'grant';

export interface WorkspaceMount {
  name: string;
  target: string;
  source?: string;
  access: WorkspaceMountAccess;
  kind: WorkspaceMountKind;
}

export interface WorkspaceResolveOptions {
  access?: 'read' | 'write' | 'readwrite' | 'list';
}

export interface ResolvedWorkspacePath {
  path: string;
  root: string;
  relativePath: string;
  access: WorkspaceMountAccess;
  mount?: WorkspaceMount;
}

export interface WorkspaceSnapshot {
  id: string;
  /**
   * Persistence backend that owns the archived bytes. `'inline-root'` means the
   * snapshot is only a pointer to a still-live root (no portable archive).
   */
  backend: string;
  /** Backend-specific locator used to restore the archive. Absent for `inline-root`. */
  ref?: string;
  /** Live root, when still on disk — enables fast-path reuse without a restore. */
  root?: string;
  createdAt?: string;
  /**
   * SHA256 of the root's contents at snapshot time. On resume, a live fixed
   * root whose fingerprint still matches lets us skip the restore (hot path);
   * a mismatch (or a fresh per-run root) forces a tar restore (cold path).
   */
  fingerprint?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Pluggable durable persistence for a workspace's bytes.
 *
 * Mirrors the reference SDK's snapshot model (persist / restore / restorable):
 * a snapshot archives the whole workspace root so it survives tmpdir loss and
 * can be rehydrated into a fresh root on a later turn or host. The backend is
 * orthogonal to the OS isolation engine.
 */
export interface SnapshotBackend {
  readonly kind: string;
  /** Archive `rootDir` and persist it under `snapshotId`. Returns the restore ref. */
  persist(snapshotId: string, rootDir: string): Promise<string>;
  /** Restore a previously persisted archive (by `ref`) into `destDir`. */
  restore(ref: string, destDir: string): Promise<void>;
  /** Whether `ref` can be restored right now. */
  restorable(ref: string): Promise<boolean>;
}

export interface SandboxCommand {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxCommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
}

export interface WorkspaceSession {
  id: string;
  root: string;
  mode: WorkspaceAccessMode;
  mounts: WorkspaceMount[];
  resolve(path: string, options?: WorkspaceResolveOptions): Promise<ResolvedWorkspacePath>;
  run?(command: SandboxCommand): Promise<SandboxCommandResult>;
  snapshot?(): Promise<WorkspaceSnapshot>;
  cleanup(): Promise<void>;
}

export interface WorkspaceAcquireOptions {
  baseWorkdir?: string;
  runId?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceProvider {
  acquire(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>;
}

export interface SandboxClient {
  create(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>;
  resume?(state: WorkspaceSnapshot): Promise<WorkspaceSession>;
  delete?(session: WorkspaceSession): Promise<void>;
}
