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
import { createSandboxServer } from '../server.js';

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

async function start(): Promise<string> {
  const server = createSandboxServer({ client: new FakeClient() });
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
});
