import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolvePathAgainstRoot,
  type ResolvedWorkspacePath,
  type SandboxClient,
  type SandboxCommand,
  type WorkspaceAcquireOptions,
  type WorkspaceResolveOptions,
  type WorkspaceSession,
} from '@dongkseo/contracts';
import { createSandboxServer } from '../server.js';
import { SessionRegistry } from '../session-registry.js';
import type { ArchiveStore } from '../archive-store.js';

// Fake backend that honors options.rootDir the way AsrtSandboxClient does:
// external root wins over per-run minting and cleanup keeps the directory.
class RootAwareFakeClient implements SandboxClient {
  readonly createOptions: WorkspaceAcquireOptions[] = [];

  async create(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    this.createOptions.push(options);
    const external = options.rootDir !== undefined;
    const root = external
      ? path.resolve(options.rootDir!)
      : await fsp.mkdtemp(path.join(os.tmpdir(), 'rootdir-test-'));
    await fsp.mkdir(root, { recursive: true });
    return {
      id: crypto.randomUUID(),
      root,
      mode: 'workspace-write',
      mounts: [],
      async resolve(rawPath: string, opts: WorkspaceResolveOptions = {}): Promise<ResolvedWorkspacePath> {
        const { canonicalRoot, finalPath } = await resolvePathAgainstRoot(rawPath, root);
        const write = opts.access === 'write' || opts.access === 'readwrite';
        return {
          path: finalPath,
          root: canonicalRoot,
          relativePath: path.relative(canonicalRoot, finalPath) || '.',
          access: write ? 'rw' : 'ro',
        };
      },
      async run(command: SandboxCommand) {
        return { exitCode: 0, signal: null, stdout: command.argv.join(' '), stderr: '' };
      },
      async cleanup() {
        if (!external) await fsp.rm(root, { recursive: true, force: true });
      },
    };
  }
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await Promise.all(dirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function start(rootAllowPrefixes?: string[]): Promise<{ endpoint: string; client: RootAwareFakeClient }> {
  const client = new RootAwareFakeClient();
  const { server } = createSandboxServer({ client, rootAllowPrefixes });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, client };
}

async function postSession(endpoint: string, body: unknown): Promise<Response> {
  return fetch(`${endpoint}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /sessions rootDir gate', () => {
  it('403s every rootDir request when no allowlist is configured', async () => {
    const { endpoint, client } = await start();
    const res = await postSession(endpoint, { rootDir: '/etc' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('root_denied');
    expect(client.createOptions).toHaveLength(0);
  });

  it('403s a rootDir outside the allowed prefixes (including .. traversal)', async () => {
    const allow = await tempDir('allow-');
    const { endpoint } = await start([allow]);
    for (const rootDir of ['/etc', `${allow}/../etc`, `${allow}x/evil`]) {
      const res = await postSession(endpoint, { rootDir });
      expect(res.status, rootDir).toBe(403);
    }
  });

  it('accepts an allowed rootDir and roots the session there', async () => {
    const allow = await tempDir('allow-');
    const rootDir = path.join(allow, 'ws', 'task1', 'workdir');
    const { endpoint, client } = await start([allow]);

    const res = await postSession(endpoint, { rootDir });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; root: string };
    expect(body.root).toBe(rootDir);
    expect(client.createOptions[0]?.rootDir).toBe(rootDir);
  });

  it('plain sessions (no rootDir) are unaffected by the allowlist', async () => {
    const { endpoint } = await start([]);
    const res = await postSession(endpoint, {});
    expect(res.status).toBe(200);
  });
});

describe('SessionRegistry non-archivable entries', () => {
  function makeStore(): ArchiveStore & { archive: ReturnType<typeof vi.fn> } {
    return {
      archive: vi.fn(async () => true),
      thaw: vi.fn(async () => undefined),
      delete: vi.fn(async () => {}),
      sweepStale: vi.fn(async () => {}),
    } as unknown as ArchiveStore & { archive: ReturnType<typeof vi.fn> };
  }

  async function makeKeepSession(): Promise<{ session: WorkspaceSession; cleanup: ReturnType<typeof vi.fn> }> {
    const cleanup = vi.fn(async () => {});
    const session: WorkspaceSession = {
      id: crypto.randomUUID(),
      root: await tempDir('keep-'),
      mode: 'workspace-write',
      mounts: [],
      async resolve() {
        throw new Error('not used');
      },
      async run() {
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
      cleanup,
    };
    return { session, cleanup };
  }

  it('idle sweep destroys (not archives) a non-archivable session', async () => {
    const store = makeStore();
    const registry = new SessionRegistry(store, { idleTtlMs: 1 });
    const { session, cleanup } = await makeKeepSession();
    registry.register('ext-1', session, { archivable: false });

    await registry.sweep(Date.now() + 10_000);

    expect(store.archive).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(registry.acquire('ext-1')).toBeUndefined();
  });

  it('shutdown archiveAll cleans up (not archives) a non-archivable session', async () => {
    const store = makeStore();
    const registry = new SessionRegistry(store, { idleTtlMs: 60_000 });
    const { session, cleanup } = await makeKeepSession();
    registry.register('ext-2', session, { archivable: false });

    await registry.archiveAll();

    expect(store.archive).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('default registrations stay archivable', async () => {
    const store = makeStore();
    const registry = new SessionRegistry(store, { idleTtlMs: 1 });
    const { session } = await makeKeepSession();
    registry.register('arch-1', session);

    await registry.sweep(Date.now() + 10_000);

    expect(store.archive).toHaveBeenCalledTimes(1);
  });
});
