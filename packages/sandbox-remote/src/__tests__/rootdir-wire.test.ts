import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RemoteSandboxClient } from '../client.js';

interface CapturedRequest {
  method: string;
  path: string;
  body?: unknown;
}

// Fetch stub capturing wire bodies — the assertions here are about WHAT the
// client sends, not server behavior (covered in sandbox-server's tests).
function makeFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    captured.push({ method: init?.method ?? 'GET', path: url.pathname, body });
    const json = url.pathname === '/sessions'
      ? { sessionId: 'wire-1', root: '/srv/ws/task/workdir' }
      : { alive: false };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('RemoteSandboxClient rootDir wire transmission', () => {
  it('sends rootDir on create', async () => {
    const captured: CapturedRequest[] = [];
    const client = new RemoteSandboxClient({
      endpoint: 'http://sbx.local',
      rootDir: '/srv/ws/task/workdir',
      fetch: makeFetch(captured),
    });

    const session = await client.create({ runId: 'r1' });

    const create = captured.find((r) => r.path === '/sessions');
    expect((create?.body as { rootDir?: string }).rootDir).toBe('/srv/ws/task/workdir');
    expect(session.root).toBe('/srv/ws/task/workdir');
  });

  it('per-acquire rootDir overrides the client default', async () => {
    const captured: CapturedRequest[] = [];
    const client = new RemoteSandboxClient({
      endpoint: 'http://sbx.local',
      rootDir: '/srv/ws/default',
      fetch: makeFetch(captured),
    });

    await client.create({ rootDir: '/srv/ws/override' });

    expect((captured[0]?.body as { rootDir?: string }).rootDir).toBe('/srv/ws/override');
  });

  it('cold resume re-sends rootDir and never hydrates a spooled archive over it', async () => {
    const captured: CapturedRequest[] = [];
    const client = new RemoteSandboxClient({
      endpoint: 'http://sbx.local',
      rootDir: '/srv/ws/task/workdir',
      fetch: makeFetch(captured),
    });
    // A real spooled tar on disk — hydrate MUST still be skipped for rootDir sessions.
    const spool = await fsp.mkdtemp(path.join(os.tmpdir(), 'spool-'));
    const ref = path.join(spool, 'snap.tar');
    await fsp.writeFile(ref, Buffer.from('stale-bytes'));
    try {
      await client.resume({
        backend: 'remote',
        ref: 'dead-session',
        snapshot: {
          id: 'dead-session',
          backend: 'remote-tar',
          ref,
          createdAt: new Date().toISOString(),
        },
      });

      const create = captured.find((r) => r.path === '/sessions');
      expect((create?.body as { rootDir?: string }).rootDir).toBe('/srv/ws/task/workdir');
      expect(captured.some((r) => r.path.endsWith('/hydrate'))).toBe(false);
    } finally {
      await fsp.rm(spool, { recursive: true, force: true });
    }
  });
});
