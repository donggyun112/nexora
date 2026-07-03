import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolvePathAgainstRoot,
  type ResolvedWorkspacePath,
  type SandboxClient,
  type SandboxCommand,
  type WorkspaceAcquireOptions,
  type WorkspaceResolveOptions,
  type WorkspaceSession,
} from '@dongkseo/contracts';
import { createSandboxServer } from '@dongkseo/sandbox-server';
import { RemoteSandboxClient } from '../client.js';

// A platform-independent local backend for the server to front: real temp-dir
// roots (so writeTar/safeExtractTar operate on actual files) with an echoing
// exec so tests do not depend on any host binary.
class FakeLocalClient implements SandboxClient {
  readonly roots: string[] = [];

  async create(_options?: WorkspaceAcquireOptions): Promise<WorkspaceSession> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fake-sbx-'));
    this.roots.push(root);
    return new FakeSession(crypto.randomUUID(), root);
  }

  async delete(session: WorkspaceSession): Promise<void> {
    await session.cleanup();
  }
}

class FakeSession implements WorkspaceSession {
  readonly mode = 'workspace-write' as const;
  readonly mounts = [];
  constructor(
    readonly id: string,
    readonly root: string,
  ) {}

  async resolve(rawPath: string, options: WorkspaceResolveOptions = {}): Promise<ResolvedWorkspacePath> {
    const { canonicalRoot, finalPath } = await resolvePathAgainstRoot(rawPath, this.root);
    const rel = path.relative(canonicalRoot, finalPath) || '.';
    const write = options.access === 'write' || options.access === 'readwrite';
    return { path: finalPath, root: canonicalRoot, relativePath: rel, access: write ? 'rw' : 'ro' };
  }

  async run(command: SandboxCommand) {
    return {
      exitCode: 0,
      signal: null,
      stdout: command.argv.join(' '),
      stderr: '',
    };
  }

  async cleanup(): Promise<void> {
    await fsp.rm(this.root, { recursive: true, force: true });
  }
}

const servers: Server[] = [];
const spools: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await Promise.all(spools.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

async function startServer(token?: string): Promise<{ endpoint: string; backend: FakeLocalClient }> {
  const backend = new FakeLocalClient();
  const server = createSandboxServer({ client: backend, token });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, backend };
}

function mkClient(endpoint: string, token?: string): RemoteSandboxClient {
  const spoolDir = path.join(os.tmpdir(), `remote-spool-${crypto.randomUUID()}`);
  spools.push(spoolDir);
  return new RemoteSandboxClient({ endpoint, token, spoolDir });
}

/** Raw wire helpers exercising the server's /fs routes directly. */
async function putFile(endpoint: string, id: string, rel: string, data: string, token?: string): Promise<void> {
  const res = await fetch(`${endpoint}/sessions/${id}/fs?path=${encodeURIComponent(rel)}`, {
    method: 'PUT',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: data,
  });
  if (!res.ok) throw new Error(`put failed: ${res.status}`);
}
async function getFile(endpoint: string, id: string, rel: string, token?: string): Promise<string> {
  const res = await fetch(`${endpoint}/sessions/${id}/fs?path=${encodeURIComponent(rel)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`get failed: ${res.status}`);
  return await res.text();
}

describe('RemoteSandboxClient ↔ sandbox-server (portability axis)', () => {
  it('creates a session and runs a command over the wire', async () => {
    const { endpoint } = await startServer();
    const client = mkClient(endpoint);
    const session = await client.create({ runId: 'conv-1' });

    const result = await session.run!({ argv: ['echo', 'hello'] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('echo hello');

    await session.cleanup();
  });

  it('re-attaches to a still-live session on resume (HOT)', async () => {
    const { endpoint } = await startServer();
    const client = mkClient(endpoint);
    const session = await client.create();
    await putFile(endpoint, session.id, 'note.txt', 'persisted');

    const state = await session.sessionState!();
    expect(state.backend).toBe('remote');
    expect(state.ref).toBe(session.id);

    const resumed = await client.resume(state);
    expect(resumed.id).toBe(session.id); // same live session re-bound
    expect(await getFile(endpoint, resumed.id, 'note.txt')).toBe('persisted');

    await resumed.cleanup();
  });

  it('recreates and rehydrates when the session is gone (COLD)', async () => {
    const { endpoint } = await startServer();
    const client = mkClient(endpoint);
    const session = await client.create();
    await putFile(endpoint, session.id, 'keep.txt', 'survives-restart');

    const state = await session.sessionState!();
    await session.cleanup(); // remote session is now gone → reattach must fail

    const resumed = await client.resume(state);
    expect(resumed.id).not.toBe(session.id); // a fresh session
    expect(await getFile(endpoint, resumed.id, 'keep.txt')).toBe('survives-restart');

    await resumed.cleanup();
  });

  it('reads and writes files through the session over the wire', async () => {
    const { endpoint } = await startServer();
    const client = mkClient(endpoint);
    const session = await client.create();

    await session.fs!.writeFile('dir/hello.txt', Buffer.from('over-the-wire'));
    const bytes = await session.fs!.readFile('dir/hello.txt');
    expect(Buffer.from(bytes).toString('utf8')).toBe('over-the-wire');

    await expect(session.fs!.readFile('../../etc/passwd')).rejects.toThrow(/outside workspace root/);
    await session.cleanup();
  });

  it('rejects paths escaping the workspace root', async () => {
    const { endpoint } = await startServer();
    const client = mkClient(endpoint);
    const session = await client.create();
    await expect(session.resolve('../../etc/passwd', { access: 'read' })).rejects.toThrow(/outside workspace root/);
    await session.cleanup();
  });

  it('enforces the bearer token', async () => {
    const { endpoint } = await startServer('secret-token');
    const good = mkClient(endpoint, 'secret-token');
    const bad = mkClient(endpoint, 'wrong');

    await expect(good.create()).resolves.toBeDefined();
    await expect(bad.create()).rejects.toMatchObject({ status: 401 });
  });

  it('does not expose wrapCommand on remote sessions (server-side isolation)', async () => {
    const { endpoint } = await startServer();
    const client = mkClient(endpoint);
    const session = await client.create();
    expect(session.wrapCommand).toBeUndefined();
    await session.cleanup();
  });
});
