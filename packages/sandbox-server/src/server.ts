/**
 * Reference sandbox server — exposes the provider-neutral sandbox wire protocol
 * over HTTP.
 *
 * The server owns no isolation of its own: it delegates session provisioning and
 * execution to an injected `SandboxClient` (e.g. `AsrtSandboxClient` from
 * `@dongkseo/core`, or a container-backed client later). This keeps the package
 * dependent on `@dongkseo/contracts` alone and lets the same routes front any
 * backend. Workspace persist/hydrate reuse the hardened `writeTar` /
 * `safeExtractTar` archive boundary so bytes crossing the wire are validated on
 * extraction.
 *
 * Endpoints:
 *   POST   /sessions                 → { sessionId, root }
 *   POST   /sessions/:id/exec        → SandboxCommandResult
 *   GET    /sessions/:id/fs?path=    → file bytes
 *   PUT    /sessions/:id/fs?path=    → { ok }
 *   POST   /sessions/:id/persist     → tar bytes
 *   POST   /sessions/:id/hydrate     → { ok }
 *   POST   /sessions/:id/reattach    → { alive, root? }
 *   DELETE /sessions/:id             → { ok }
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ArchiveLimits,
  CreateSessionRequest,
  CreateSessionResponse,
  ExecRequest,
  ReattachResponse,
  ResolvedWorkspacePath,
  SandboxClient,
  SandboxErrorResponse,
  WorkspaceSession,
} from '@dongkseo/contracts';
import { safeExtractTar, writeTar } from '@dongkseo/contracts';
import { TarArchiveStore, type ArchiveStore } from './archive-store.js';
import { SessionRegistry, type SessionLifecycleOptions } from './session-registry.js';

export type { SessionLifecycleOptions } from './session-registry.js';

export interface SandboxServerOptions {
  /** Backend that provisions and rehydrates sessions (e.g. AsrtSandboxClient). */
  client: SandboxClient;
  /** Optional bearer token required on every request. */
  token?: string;
  /** Extraction limits applied on hydrate. */
  archiveLimits?: ArchiveLimits;
  /** Session lifecycle (idle archive / thaw / archive TTL). Defaults always apply. */
  lifecycle?: SessionLifecycleOptions;
  /** Archive 매체 오버라이드. 미지정 시 tar 파일 store (현행 동작). */
  archiveStore?: ArchiveStore;
  /**
   * Absolute path prefixes a `CreateSessionRequest.rootDir` may live under.
   * Empty/unset (default) disables external-root sessions entirely — every
   * rootDir request is rejected with 403. Sessions accepted through this gate
   * are registered non-archivable: the idle sweep destroys the live session
   * without tar-ing the caller-owned directory, and cleanup never deletes it.
   */
  rootAllowPrefixes?: string[];
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean | null = false,
  ) {
    super(message);
  }
}

export interface SandboxServerHandle {
  server: Server;
  /** Stop the sweep, archive every live session, and close the server. */
  shutdown(): Promise<void>;
}

export function createSandboxServer(options: SandboxServerOptions): SandboxServerHandle {
  const store =
    options.archiveStore ??
    new TarArchiveStore(options.client, {
      archiveDir: options.lifecycle?.archiveDir,
      archiveLimits: options.archiveLimits,
    });
  const registry = new SessionRegistry(store, options.lifecycle);
  const server = createServer((req, res) => {
    handle(req, res, options, registry).catch((err) => sendError(res, err));
  });
  registry.start();
  // Abrupt close (no shutdown()): stop sweeping and drop live sessions un-archived.
  server.on('close', () => {
    registry.stop();
    void registry.destroyAllLive().catch(() => {});
  });
  const shutdown = async (): Promise<void> => {
    registry.stop();
    await registry.archiveAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, shutdown };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: SandboxServerOptions,
  registry: SessionRegistry,
): Promise<void> {
  authorize(req, options.token);

  const url = new URL(req.url ?? '/', 'http://sandbox.local');
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['sessions', ':id', 'exec']
  const method = req.method ?? 'GET';

  if (parts[0] !== 'sessions') throw new HttpError(404, 'not_found', 'unknown route');

  // POST /sessions
  if (parts.length === 1 && method === 'POST') {
    const body = await readJson<CreateSessionRequest>(req);
    const rootDir = body.rootDir ? validateRootDir(body.rootDir, options.rootAllowPrefixes) : undefined;
    // wire id 를 먼저 민팅해 backend 에 키로 전달한다 — durable backend 는
    // 이 키로 디스크 상태를 잡아 thaw(wire id) 가 성립한다. (tar backend 는 무시)
    const id = crypto.randomUUID();
    const session = await options.client.create({
      runId: body.runId,
      manifest: body.manifest,
      rootDir,
      metadata: { sessionKey: id },
    });
    registry.register(id, session, { archivable: rootDir === undefined });
    return sendJson(res, 200, { sessionId: id, root: session.root } satisfies CreateSessionResponse);
  }

  const id = parts[1];
  const sub = parts[2];
  if (!id) throw new HttpError(404, 'not_found', 'missing session id');

  // DELETE /sessions/:id
  if (parts.length === 2 && method === 'DELETE') {
    await registry.destroy(id);
    return sendJson(res, 200, { ok: true });
  }

  // POST /sessions/:id/reattach — tolerated even if the session is gone.
  if (sub === 'reattach' && method === 'POST') {
    const state = await registry.reattach(id);
    return sendJson(res, 200, state satisfies ReattachResponse);
  }

  const session = registry.acquire(id);
  if (!session) throw new HttpError(404, 'session_not_found', `no live session ${id}`, false);
  try {
    // POST /sessions/:id/exec
    if (sub === 'exec' && method === 'POST') {
      const body = await readJson<ExecRequest>(req);
      if (!Array.isArray(body.argv) || body.argv.length === 0) {
        throw new HttpError(400, 'bad_request', 'argv must be a non-empty array');
      }
      if (!session.run) throw new HttpError(501, 'not_supported', 'session does not support exec');
      // exec cwd must be the in-jail path. resolveOrDeny validates the jail and
      // returns a host-mapped `.path` (needed for fs byte ops), but for a backend
      // whose logical root differs from its host backing (overlay: /home/agent),
      // the in-jail cwd is join(session.root, relativePath). For asrt they coincide.
      let cwd = session.root;
      if (body.cwd) {
        const r = await resolveOrDeny(session, body.cwd, 'read');
        cwd = r.relativePath === '.' ? session.root : path.join(session.root, r.relativePath);
      }
      const result = await session.run({ argv: body.argv, cwd, env: body.env, timeoutMs: body.timeoutMs });
      return sendJson(res, 200, result);
    }

    // GET/PUT /sessions/:id/fs?path=
    if (sub === 'fs') {
      const rel = url.searchParams.get('path');
      if (!rel) throw new HttpError(400, 'bad_request', 'missing path');
      if (method === 'GET') {
        const resolved = await resolveOrDeny(session, rel, 'read');
        const bytes = await fsp.readFile(resolved.path);
        return sendBytes(res, 200, bytes);
      }
      if (method === 'PUT') {
        const resolved = await resolveOrDeny(session, rel, 'write');
        const bytes = await readBytes(req);
        await writeFileNoFollow(resolved.path, bytes);
        return sendJson(res, 200, { ok: true });
      }
    }

    // GET /sessions/:id/stat?path=
    if (sub === 'stat' && method === 'GET') {
      const rel = url.searchParams.get('path');
      if (!rel) throw new HttpError(400, 'bad_request', 'missing path');
      const resolved = await resolveOrDeny(session, rel, 'read');
      let s;
      try {
        s = await fsp.lstat(resolved.path); // lstat: report a final-component symlink as-is
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new HttpError(404, 'not_found', `no such path: ${rel}`, false);
        }
        throw err;
      }
      return sendJson(res, 200, {
        size: s.size,
        mtimeMs: s.mtimeMs,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        mode: s.mode & 0o7777,
      });
    }

    // GET /sessions/:id/readdir?path=
    if (sub === 'readdir' && method === 'GET') {
      const rel = url.searchParams.get('path');
      if (!rel) throw new HttpError(400, 'bad_request', 'missing path');
      const resolved = await resolveOrDeny(session, rel, 'read');
      const entries = await fsp.readdir(resolved.path, { withFileTypes: true });
      return sendJson(res, 200, entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })));
    }

    // POST /sessions/:id/persist → tar bytes of the workspace root.
    if (sub === 'persist' && method === 'POST') {
      const archive = await writeTar(session.hostRoot ?? session.root);
      return sendBytes(res, 200, archive);
    }

    // POST /sessions/:id/hydrate ← tar bytes, extracted safely into the root.
    if (sub === 'hydrate' && method === 'POST') {
      const archive = await readBytes(req);
      await safeExtractTar(archive, session.hostRoot ?? session.root, options.archiveLimits);
      return sendJson(res, 200, { ok: true });
    }

    throw new HttpError(404, 'not_found', `unknown route ${method} ${url.pathname}`);
  } finally {
    registry.release(id);
  }
}

function authorize(req: IncomingMessage, token?: string): void {
  if (!token) return;
  const header = req.headers.authorization ?? '';
  const expected = `Bearer ${token}`;
  // Constant-time compare to avoid leaking the token via timing.
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new HttpError(401, 'unauthorized', 'invalid or missing bearer token', false);
  }
}

/**
 * Validate an external-root request against the operator allowlist. Lexical
 * (path.resolve) normalization only — the trust boundary is the operator's
 * prefix list over a mounted workspace tree, and the backend jail confines
 * reads/writes to the realpath'd root regardless.
 */
function validateRootDir(requested: string, allowPrefixes?: string[]): string {
  const resolved = path.resolve(requested);
  const allowed = (allowPrefixes ?? []).some((prefix) => {
    const p = path.resolve(prefix);
    return resolved === p || resolved.startsWith(p + path.sep);
  });
  if (!allowed) {
    throw new HttpError(403, 'root_denied', 'rootDir is not under an allowed prefix', false);
  }
  return resolved;
}

/** Resolve a workspace path, translating an out-of-root rejection into a 403. */
async function resolveOrDeny(
  session: WorkspaceSession,
  rel: string,
  access: 'read' | 'write',
): Promise<ResolvedWorkspacePath> {
  try {
    return await session.resolve(rel, { access });
  } catch (err) {
    throw new HttpError(403, 'path_denied', err instanceof Error ? err.message : String(err), false);
  }
}

async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Create/overwrite a file, refusing to follow a symlink at the final component. */
async function writeFileNoFollow(dest: string, data: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rm(dest, { force: true }).catch(() => {}); // drop an existing regular file or symlink
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  const handle = await fsp.open(dest, flags, 0o600);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBytes(req);
  if (raw.length === 0) return {} as T;
  try {
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'bad_request', 'invalid JSON body');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer): void {
  res.writeHead(status, { 'content-type': 'application/octet-stream', 'content-length': body.length });
  res.end(body);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = err instanceof HttpError ? err.status : 500;
  const payload: SandboxErrorResponse = {
    code: err instanceof HttpError ? err.code : 'internal_error',
    message: err instanceof Error ? err.message : String(err),
    retryable: err instanceof HttpError ? err.retryable : null,
  };
  sendJson(res, status, payload);
}
