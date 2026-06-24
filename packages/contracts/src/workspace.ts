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
  id?: string;
  root: string;
  metadata?: Record<string, unknown>;
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
