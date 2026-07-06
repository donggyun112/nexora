/**
 * @dongkseo/sandbox-remote — a `SandboxClient` that drives a remote sandbox over
 * the Nexora wire protocol (see `@dongkseo/sandbox-server`).
 *
 * This is the remote half of the portability axis: the same `SandboxAgent` and
 * tools run unchanged while the workspace boundary moves to a provider-managed
 * host. Isolation is enforced server-side, so the session deliberately does NOT
 * implement `wrapCommand` (there is no local jail to wrap) — callers that need
 * detached/background execution must route it server-side rather than fall back
 * to an unjailed host spawn.
 *
 * `resume()` mirrors the reference SDK's two-path model: try to re-attach to a
 * still-live remote session by `ref`, otherwise recreate a session and rehydrate
 * the saved workspace snapshot bytes.
 *
 * NOTE (follow-up): Nexora's builtin file tools (read/grep/edit/write) touch the
 * workspace root through the local filesystem, so file I/O against a genuinely
 * remote root requires growing `WorkspaceSession` with read/write methods and
 * refactoring those tools to use them. The wire protocol already exposes `/fs`
 * for that step; this client implements exec + persist/hydrate + reattach today.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import posix from 'node:path/posix';
import type {
  CreateSessionResponse,
  ExecResponse,
  ReattachResponse,
  ResolvedWorkspacePath,
  SandboxClient,
  SandboxCommand,
  SandboxCommandResult,
  SandboxErrorResponse,
  SandboxSessionState,
  WorkspaceAcquireOptions,
  WorkspaceDirEntry,
  WorkspaceFileStat,
  WorkspaceFs,
  WorkspaceProvider,
  WorkspaceResolveOptions,
  WorkspaceSession,
  WorkspaceSnapshot,
} from '@dongkseo/contracts';

export interface RemoteSandboxClientOptions {
  /** Base URL of the sandbox server, e.g. `https://sbx.example.com`. */
  endpoint: string;
  /** Bearer token sent on every request. Never serialized into session state. */
  token?: string;
  /** Directory where persisted workspace archives are spooled for cold recovery. */
  spoolDir?: string;
  /** Injected fetch (for tests); defaults to global fetch. */
  fetch?: typeof fetch;
}

export class RemoteSandboxError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly retryable: boolean | null,
  ) {
    super(message);
    this.name = 'RemoteSandboxError';
  }
}

export class RemoteSandboxClient implements SandboxClient, WorkspaceProvider {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly spoolDir: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RemoteSandboxClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.token = options.token;
    this.spoolDir = options.spoolDir ?? path.join(os.tmpdir(), 'nexora-remote-snapshots');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async acquire(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession> {
    return this.create(options);
  }

  async create(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    const created = await this.request<CreateSessionResponse>('POST', '/sessions', {
      json: { runId: options.runId, manifest: options.manifest },
    });
    await this.seedRemote(created.sessionId, options.seedDirs);
    return this.buildSession(created.sessionId, created.root);
  }

  async resume(state: SandboxSessionState, options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    // HOT: try to re-attach to a still-live remote session.
    if (state.ref) {
      try {
        const reattached = await this.request<ReattachResponse>('POST', `/sessions/${encode(state.ref)}/reattach`);
        if (reattached.alive && reattached.root) {
          return this.buildSession(state.ref, reattached.root);
        }
      } catch {
        // Fall through to cold recreation below.
      }
    }

    // COLD: recreate a fresh session and rehydrate saved workspace bytes.
    const created = await this.request<CreateSessionResponse>('POST', '/sessions', {
      json: { runId: options.runId, manifest: options.manifest },
    });
    const snapshot = state.snapshot;
    if (snapshot?.ref) {
      try {
        const bytes = await fsp.readFile(snapshot.ref);
        await this.request('POST', `/sessions/${encode(created.sessionId)}/hydrate`, { body: bytes });
      } catch {
        // Best-effort: a missing/unreadable archive yields an empty fresh workspace.
      }
    }
    await this.seedRemote(created.sessionId, options.seedDirs);
    return this.buildSession(created.sessionId, created.root);
  }

  async delete(session: WorkspaceSession): Promise<void> {
    await session.cleanup();
  }

  private buildSession(sessionId: string, root: string): WorkspaceSession {
    return new RemoteSandboxSession({
      sessionId,
      root,
      spoolDir: this.spoolDir,
      request: this.request.bind(this),
    });
  }

  private async putFileRemote(sessionId: string, relPath: string, bytes: Buffer): Promise<void> {
    await this.request('PUT', `/sessions/${encode(sessionId)}/fs?path=${encodeURIComponent(relPath)}`, {
      body: bytes,
    });
  }

  /** Seed declared dirs into the remote workspace over the /fs wire — the remote
   *  analogue of core's materializeSeedDirs (host FS copy). best-effort: a missing
   *  source or a failed file transfer never aborts session creation. Symlinks are
   *  skipped so a link can't seed outside the root-jail. */
  private async seedRemote(
    sessionId: string,
    seedDirs?: WorkspaceAcquireOptions['seedDirs'],
  ): Promise<void> {
    if (!seedDirs?.length) return;
    for (const { source, destSubpath } of seedDirs) {
      try {
        const entries = await fsp.readdir(source, { withFileTypes: true, recursive: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue; // 디렉토리·symlink 제외
          const direntCompat = entry as { parentPath?: string; path?: string };
          const parent = direntCompat.parentPath ?? direntCompat.path!;
          const abs = path.join(parent, entry.name);
          const relFromSource = path.relative(source, abs).split(path.sep).join(posix.sep);
          const relPath = posix.join(destSubpath, relFromSource);
          try {
            const bytes = await fsp.readFile(abs);
            await this.putFileRemote(sessionId, relPath, bytes);
          } catch (err) {
            console.warn(`[remote-seed] ${relPath}: ${(err as Error).message}`);
          }
        }
      } catch {
        continue; // 소스 부재/읽기 실패 → best-effort skip
      }
    }
  }

  private async request<T = unknown>(
    method: string,
    routePath: string,
    opts: { json?: unknown; body?: Buffer } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let body: string | Uint8Array | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/octet-stream';
      body = opts.body;
    }

    const res = await this.fetchImpl(`${this.endpoint}${routePath}`, { method, headers, body });
    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      let err: SandboxErrorResponse = { code: 'http_error', message: `HTTP ${res.status}`, retryable: null };
      if (contentType.includes('application/json')) {
        try {
          err = (await res.json()) as SandboxErrorResponse;
        } catch {
          // keep default
        }
      }
      throw new RemoteSandboxError(err.message, err.code, res.status, err.retryable);
    }
    if (contentType.includes('application/octet-stream')) {
      return Buffer.from(await res.arrayBuffer()) as unknown as T;
    }
    if (contentType.includes('application/json')) {
      return (await res.json()) as T;
    }
    return undefined as T;
  }
}

interface RemoteSessionOptions {
  sessionId: string;
  root: string;
  spoolDir: string;
  request: <T>(method: string, path: string, opts?: { json?: unknown; body?: Buffer }) => Promise<T>;
}

class RemoteSandboxSession implements WorkspaceSession {
  readonly id: string;
  readonly root: string;
  readonly mode = 'workspace-write' as const;
  readonly mounts = [];
  readonly fs: WorkspaceFs;
  private readonly spoolDir: string;
  private readonly request: RemoteSessionOptions['request'];
  private cleaned = false;

  constructor(options: RemoteSessionOptions) {
    this.id = options.sessionId;
    this.root = options.root;
    this.spoolDir = options.spoolDir;
    this.request = options.request;
    this.fs = this.buildFs();
  }

  async resolve(rawPath: string, options: WorkspaceResolveOptions = {}): Promise<ResolvedWorkspacePath> {
    // Remote roots cannot be realpath'd locally, so validate lexically in POSIX
    // space and reject anything escaping the root. The server re-validates.
    const rootPosix = posix.normalize(this.root);
    const joined = posix.normalize(
      posix.isAbsolute(rawPath) ? rawPath : posix.join(rootPosix, rawPath),
    );
    if (joined !== rootPosix && !joined.startsWith(rootPosix + '/')) {
      throw new Error(`Access denied: "${rawPath}" resolves outside workspace root ${rootPosix}`);
    }
    const relativePath = joined === rootPosix ? '.' : posix.relative(rootPosix, joined);
    const write = options.access === 'write' || options.access === 'readwrite';
    return { path: joined, root: rootPosix, relativePath, access: write ? 'rw' : 'ro' };
  }

  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    return this.request<ExecResponse>('POST', `/sessions/${encode(this.id)}/exec`, {
      json: { argv: command.argv, cwd: command.cwd, env: command.env, timeoutMs: command.timeoutMs },
    });
  }

  /**
   * The workspace filesystem runtime for this remote session. Every op validates
   * the path lexically (fast reject) and the server re-validates + enforces the
   * jail and no-follow write on its side.
   */
  private buildFs(): WorkspaceFs {
    const req = this.request;
    const id = this.id;
    const resolve = this.resolve.bind(this);
    const fsPath = (p: string): string => `/sessions/${encode(id)}/fs?path=${encode(p)}`;
    return {
      async readFile(p: string): Promise<Uint8Array> {
        await resolve(p, { access: 'read' });
        return req<Buffer>('GET', fsPath(p));
      },
      async writeFile(p: string, data: Uint8Array): Promise<void> {
        await resolve(p, { access: 'write' });
        await req('PUT', fsPath(p), { body: Buffer.from(data) });
      },
      async stat(p: string): Promise<WorkspaceFileStat> {
        await resolve(p, { access: 'read' });
        return req<WorkspaceFileStat>('GET', `/sessions/${encode(id)}/stat?path=${encode(p)}`);
      },
      async readdir(p: string): Promise<WorkspaceDirEntry[]> {
        await resolve(p, { access: 'read' });
        return req<WorkspaceDirEntry[]>('GET', `/sessions/${encode(id)}/readdir?path=${encode(p)}`);
      },
      async realPath(p: string): Promise<{ path: string; root: string }> {
        // Remote roots cannot be realpath'd locally; validate lexically and let
        // the server enforce on use. Returns the workspace-absolute POSIX path.
        const r = await resolve(p, { access: 'read' });
        return { path: r.path, root: r.root };
      },
    };
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    // Pull the workspace archive over the wire and spool it locally so a later
    // cold resume can re-upload it via /hydrate.
    const bytes = await this.request<Buffer>('POST', `/sessions/${encode(this.id)}/persist`);
    await fsp.mkdir(this.spoolDir, { recursive: true, mode: 0o700 });
    const ref = path.join(this.spoolDir, `${crypto.randomUUID()}.tar`);
    await fsp.writeFile(ref, bytes, { mode: 0o600 });
    return {
      id: this.id,
      backend: 'remote-tar',
      ref,
      createdAt: new Date().toISOString(),
      metadata: { remoteSessionId: this.id },
    };
  }

  async sessionState(): Promise<SandboxSessionState> {
    // `ref` is the live remote session id (for re-attach); the embedded snapshot
    // is the cold-recovery fallback. No credentials are included.
    return { backend: 'remote', ref: this.id, snapshot: await this.snapshot() };
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    try {
      await this.request('DELETE', `/sessions/${encode(this.id)}`);
    } catch {
      // Best-effort teardown: the server sweeps idle sessions via TTL anyway.
    }
  }
}

function encode(id: string): string {
  return encodeURIComponent(id);
}
