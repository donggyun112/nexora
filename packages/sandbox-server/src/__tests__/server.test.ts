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
  type WorkspaceResolveOptions,
  type WorkspaceSession,
} from '@dongkseo/contracts';
import { createSandboxServer, type SandboxServerHandle, type SessionLifecycleOptions } from '../server.js';

class FakeClient implements SandboxClient {
  async create(): Promise<WorkspaceSession> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'srv-test-'));
    return {
      id: crypto.randomUUID(),
      root,
      mode: 'workspace-write',
      mounts: [],
      async resolve(rawPath: string, options: WorkspaceResolveOptions = {}): Promise<ResolvedWorkspacePath> {
        const { canonicalRoot, finalPath } = await resolvePathAgainstRoot(rawPath, root);
        const write = options.access === 'write' || options.access === 'readwrite';
        return {
          path: finalPath,
          root: canonicalRoot,
          relativePath: path.relative(canonicalRoot, finalPath) || '.',
          access: write ? 'rw' : 'ro',
        };
      },
      async run(command: SandboxCommand) {
        if (command.argv[0] === 'sleep') {
          await new Promise((r) => setTimeout(r, Number(command.argv[1] ?? 0)));
        }
        return { exitCode: 0, signal: null, stdout: command.argv.join(' '), stderr: '' };
      },
      async cleanup() {
        await fsp.rm(root, { recursive: true, force: true });
      },
    };
  }
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function start(lifecycle?: SessionLifecycleOptions): Promise<string> {
  const { server } = createSandboxServer({ client: new FakeClient(), lifecycle });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function createSession(endpoint: string): Promise<string> {
  const res = await fetch(`${endpoint}/sessions`, { method: 'POST', body: '{}' });
  return ((await res.json()) as { sessionId: string }).sessionId;
}

describe('createSandboxServer', () => {
  it('returns a normalized error envelope for unknown routes', async () => {
    const endpoint = await start();
    const res = await fetch(`${endpoint}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; retryable: boolean | null };
    expect(body.code).toBe('not_found');
    expect(body).toHaveProperty('retryable');
  });

  it('404s exec against an unknown session', async () => {
    const endpoint = await start();
    const res = await fetch(`${endpoint}/sessions/ghost/exec`, {
      method: 'POST',
      body: JSON.stringify({ argv: ['echo', 'x'] }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('session_not_found');
  });

  it('round-trips a file via /fs and re-tars it via persist/hydrate', async () => {
    const endpoint = await start();
    const id = await createSession(endpoint);

    await fetch(`${endpoint}/sessions/${id}/fs?path=a.txt`, { method: 'PUT', body: 'content-A' });
    const persisted = await fetch(`${endpoint}/sessions/${id}/persist`, { method: 'POST' });
    const archive = Buffer.from(await persisted.arrayBuffer());
    expect(archive.length).toBeGreaterThan(0);

    // A fresh session hydrated from the archive must contain the same file.
    const id2 = await createSession(endpoint);
    await fetch(`${endpoint}/sessions/${id2}/hydrate`, { method: 'POST', body: archive });
    const got = await fetch(`${endpoint}/sessions/${id2}/fs?path=a.txt`);
    expect(await got.text()).toBe('content-A');
  });

  it('reports reattach liveness and releases on delete', async () => {
    const endpoint = await start();
    const id = await createSession(endpoint);

    const alive = await fetch(`${endpoint}/sessions/${id}/reattach`, { method: 'POST' });
    expect(((await alive.json()) as { alive: boolean }).alive).toBe(true);

    await fetch(`${endpoint}/sessions/${id}`, { method: 'DELETE' });
    const dead = await fetch(`${endpoint}/sessions/${id}/reattach`, { method: 'POST' });
    expect(((await dead.json()) as { alive: boolean }).alive).toBe(false);
  });

  it('rejects a path escaping the workspace root', async () => {
    const endpoint = await start();
    const id = await createSession(endpoint);
    const res = await fetch(`${endpoint}/sessions/${id}/fs?path=${encodeURIComponent('../../etc/passwd')}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('path_denied');
    expect(body.message).toContain('outside workspace root');
  });

  it('shutdown archives live sessions before closing', async () => {
    const archiveDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'srv-arch-'));
    const handle = createSandboxServer({ client: new FakeClient(), lifecycle: { archiveDir } });
    servers.push(handle.server);
    await new Promise<void>((r) => handle.server.listen(0, '127.0.0.1', r));
    const { port } = handle.server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}`;

    const id = await createSession(endpoint);
    await fetch(`${endpoint}/sessions/${id}/fs?path=a.txt`, { method: 'PUT', body: 'archive-me' });
    await handle.shutdown();

    const stat = await fsp.stat(path.join(archiveDir, `${id}.tar`));
    expect(stat.size).toBeGreaterThan(0);
    await fsp.rm(archiveDir, { recursive: true, force: true });
  });
});

describe('session lifecycle (idle TTL / archive)', () => {
  async function startWithLifecycle(lifecycle: SessionLifecycleOptions): Promise<{ endpoint: string; archiveDir: string }> {
    const archiveDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'srv-arch-'));
    const { server } = createSandboxServer({ client: new FakeClient(), lifecycle: { archiveDir, ...lifecycle } });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return { endpoint: `http://127.0.0.1:${port}`, archiveDir };
  }

  it('archives an idle session: live routes 404 and a tar appears', async () => {
    const { endpoint, archiveDir } = await startWithLifecycle({ idleTtlMs: 40, sweepIntervalMs: 15, archiveTtlMs: 60_000 });
    const id = await createSession(endpoint);
    await fetch(`${endpoint}/sessions/${id}/fs?path=f.txt`, { method: 'PUT', body: 'frozen' });

    await new Promise((r) => setTimeout(r, 250));

    const res = await fetch(`${endpoint}/sessions/${id}/fs?path=f.txt`);
    expect(res.status).toBe(404);
    const stat = await fsp.stat(path.join(archiveDir, `${id}.tar`));
    expect(stat.size).toBeGreaterThan(0);
  });

  it('keeps a session alive while requests keep touching it', async () => {
    const { endpoint, archiveDir } = await startWithLifecycle({ idleTtlMs: 150, sweepIntervalMs: 20, archiveTtlMs: 60_000 });
    const id = await createSession(endpoint);
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 100)); // 누적 300ms > idleTtl, but each gap < idleTtl
      const res = await fetch(`${endpoint}/sessions/${id}/exec`, {
        method: 'POST',
        body: JSON.stringify({ argv: ['echo', 'touch'] }),
      });
      expect(res.status).toBe(200);
    }
    await expect(fsp.stat(path.join(archiveDir, `${id}.tar`))).rejects.toThrow();
  });

  it('does not sweep a session with an in-flight request', async () => {
    const { endpoint, archiveDir } = await startWithLifecycle({ idleTtlMs: 30, sweepIntervalMs: 10, archiveTtlMs: 60_000 });
    const id = await createSession(endpoint);
    const execP = fetch(`${endpoint}/sessions/${id}/exec`, {
      method: 'POST',
      body: JSON.stringify({ argv: ['sleep', '250'] }),
    });
    await new Promise((r) => setTimeout(r, 150)); // idle TTL 훌쩍 경과 + sweep 여러 번 — in-flight 라 보존돼야
    await expect(fsp.stat(path.join(archiveDir, `${id}.tar`))).rejects.toThrow();
    const res = await execP;
    expect(res.status).toBe(200);
  });

  it('deletes archives older than the archive TTL', async () => {
    const { endpoint, archiveDir } = await startWithLifecycle({ idleTtlMs: 30, sweepIntervalMs: 10, archiveTtlMs: 80 });
    const id = await createSession(endpoint);
    await new Promise((r) => setTimeout(r, 120)); // archive 로 전환될 시간
    await new Promise((r) => setTimeout(r, 200)); // archive TTL 초과
    await expect(fsp.stat(path.join(archiveDir, `${id}.tar`))).rejects.toThrow();
    const dead = await fetch(`${endpoint}/sessions/${id}/reattach`, { method: 'POST' });
    expect(((await dead.json()) as { alive: boolean }).alive).toBe(false);
  });

  it('thaws an archived session on reattach under the same id', async () => {
    const { endpoint, archiveDir } = await startWithLifecycle({ idleTtlMs: 40, sweepIntervalMs: 15, archiveTtlMs: 60_000 });
    const id = await createSession(endpoint);
    await fetch(`${endpoint}/sessions/${id}/fs?path=keep.txt`, { method: 'PUT', body: 'thaw-me' });

    await new Promise((r) => setTimeout(r, 250)); // archive 로 전환
    await fsp.stat(path.join(archiveDir, `${id}.tar`)); // 전제: archive 존재

    const re = await fetch(`${endpoint}/sessions/${id}/reattach`, { method: 'POST' });
    const body = (await re.json()) as { alive: boolean; root?: string };
    expect(body.alive).toBe(true);
    expect(body.root).toBeTruthy();

    const got = await fetch(`${endpoint}/sessions/${id}/fs?path=keep.txt`);
    expect(await got.text()).toBe('thaw-me');
    await expect(fsp.stat(path.join(archiveDir, `${id}.tar`))).rejects.toThrow(); // thaw 후 archive 소거
  });

  it('DELETE removes the archive too (explicit teardown is total)', async () => {
    const { endpoint, archiveDir } = await startWithLifecycle({ idleTtlMs: 40, sweepIntervalMs: 15, archiveTtlMs: 60_000 });
    const id = await createSession(endpoint);
    await new Promise((r) => setTimeout(r, 250)); // archive 로 전환
    await fsp.stat(path.join(archiveDir, `${id}.tar`));

    await fetch(`${endpoint}/sessions/${id}`, { method: 'DELETE' });
    await expect(fsp.stat(path.join(archiveDir, `${id}.tar`))).rejects.toThrow();
    const dead = await fetch(`${endpoint}/sessions/${id}/reattach`, { method: 'POST' });
    expect(((await dead.json()) as { alive: boolean }).alive).toBe(false);
  });
});
