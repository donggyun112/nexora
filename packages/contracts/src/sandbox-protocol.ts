/**
 * Sandbox wire protocol — provider-neutral DTOs shared by the remote client
 * (`@dongkseo/sandbox-remote`) and the reference server (`@dongkseo/sandbox-server`).
 *
 * The protocol generalizes the reference SDK's hosted-sandbox shape (Cloudflare
 * et al.): a session is provisioned over HTTP, commands and file I/O go over the
 * wire, and the workspace can be persisted/hydrated as a tar archive so a later
 * turn can re-attach (`ref` still alive) or recreate + rehydrate (`ref` gone).
 *
 * Transport binding (routes) lives with the server; these are the payload
 * contracts only. Credentials are carried in transport auth headers and MUST NOT
 * appear in any DTO below.
 */

import type { SandboxCommandResult, WorkspaceManifest, WorkspaceSnapshot } from './workspace.js';

/** `POST /sessions` request: provision a fresh session. */
export interface CreateSessionRequest {
  runId?: string;
  manifest?: WorkspaceManifest;
  /**
   * Externally managed absolute root to bind the session to (see
   * `WorkspaceAcquireOptions.rootDir`). Servers MUST validate it against an
   * operator-configured allowlist and reject with 403 otherwise; accepted
   * sessions are non-archivable and their cleanup never deletes the directory.
   */
  rootDir?: string;
}

/** `POST /sessions` response. */
export interface CreateSessionResponse {
  sessionId: string;
  /** Absolute workspace root inside the sandbox (POSIX). */
  root: string;
}

/** `POST /sessions/:id/exec` request. */
export interface ExecRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** `POST /sessions/:id/exec` response — mirrors `SandboxCommandResult`. */
export type ExecResponse = SandboxCommandResult;

/** `POST /sessions/:id/reattach` response. */
export interface ReattachResponse {
  /** Whether the referenced session is still live and was re-bound. */
  alive: boolean;
  root?: string;
}

/** Normalized error envelope returned by every route on failure. */
export interface SandboxErrorResponse {
  code: string;
  message: string;
  /** Whether the caller may retry; null when unknown. */
  retryable: boolean | null;
}

/** Snapshot descriptor returned/accepted alongside archive bytes. */
export interface RemoteSnapshotRef {
  snapshot: WorkspaceSnapshot;
}
