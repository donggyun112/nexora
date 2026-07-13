import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isPathAllowed, sanitizeForwardHeaders, startAuthInjectingGateway, type AuthInjectingGatewayHandle } from '../auth-gateway.js';

describe('isPathAllowed', () => {
  it('allows an exact prefix match and sub-paths', () => {
    expect(isPathAllowed('/v1/messages', ['/v1/messages'])).toBe(true);
    expect(isPathAllowed('/v1/messages?beta=true', ['/v1/messages'])).toBe(true);
  });
  it('rejects paths outside the allowlist', () => {
    expect(isPathAllowed('/v1/organizations', ['/v1/messages'])).toBe(false);
    expect(isPathAllowed('/../secrets', ['/v1/messages'])).toBe(false);
  });
});

describe('sanitizeForwardHeaders', () => {
  it('strips jail auth + hop headers and injects the real credential', () => {
    const out = sanitizeForwardHeaders(
      {
        authorization: 'Bearer dummy-no-authority',
        'x-api-key': 'dummy',
        host: '127.0.0.1',
        connection: 'keep-alive',
        'content-length': '2235',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219',
        'content-type': 'application/json',
      },
      { authorization: 'Bearer REAL-TOKEN', 'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219' },
    );
    expect(out.authorization).toBe('Bearer REAL-TOKEN');
    expect(out['x-api-key']).toBeUndefined();
    expect(out.host).toBeUndefined();
    expect(out.connection).toBeUndefined();
    expect(out['content-length']).toBeUndefined();
    expect(out['anthropic-version']).toBe('2023-06-01');
    expect(out['content-type']).toBe('application/json');
    // inject overrides an incoming same-named header
    expect(out['anthropic-beta']).toBe('oauth-2025-04-20,claude-code-20250219');
  });
});

// Talk to a unix-socket HTTP server the way the jail's socat bridge does.
function request(socketPath: string, opts: http.RequestOptions & { body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: opts.path, method: opts.method, headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let gw: AuthInjectingGatewayHandle | undefined;
let upstream: http.Server | undefined;
afterEach(async () => {
  await gw?.close();
  gw = undefined;
  if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
  upstream = undefined;
});

const sock = () => path.join(os.tmpdir(), `authgw-${crypto.randomUUID()}.sock`);

describe('startAuthInjectingGateway', () => {
  it('answers HEAD / preflight with 200 and no upstream call', async () => {
    gw = await startAuthInjectingGateway({ socketPath: sock(), upstreamOrigin: 'http://127.0.0.1:1', getAuthHeaders: () => ({}) });
    const res = await request(gw.socketPath, { path: '/', method: 'HEAD' });
    expect(res.status).toBe(200);
  });

  it('rejects a non-allowlisted path with 403', async () => {
    gw = await startAuthInjectingGateway({ socketPath: sock(), upstreamOrigin: 'http://127.0.0.1:1', getAuthHeaders: () => ({}) });
    const res = await request(gw.socketPath, { path: '/v1/organizations', method: 'GET' });
    expect(res.status).toBe(403);
  });

  it('strips the dummy token, injects the real one, and forwards to upstream', async () => {
    let seenAuth: string | undefined;
    let seenBeta: string | undefined;
    let seenBody = '';
    upstream = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      seenBeta = req.headers['anthropic-beta'] as string;
      req.on('data', (c) => (seenBody += c));
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as { port: number }).port;

    gw = await startAuthInjectingGateway({
      socketPath: sock(),
      upstreamOrigin: `http://127.0.0.1:${port}`,
      getAuthHeaders: () => ({ authorization: 'Bearer REAL-TOKEN' }),
    });
    const res = await request(gw.socketPath, {
      path: '/v1/messages?beta=true',
      method: 'POST',
      headers: { authorization: 'Bearer dummy-no-authority', 'anthropic-beta': 'claude-code-20250219', 'content-type': 'application/json' },
      body: '{"stream":true}',
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(seenAuth).toBe('Bearer REAL-TOKEN');
    expect(seenBeta).toBe('claude-code-20250219');
    expect(seenBody).toBe('{"stream":true}');
  });

  it('streams SSE chunks through without buffering', async () => {
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: a\ndata: 1\n\n');
      res.write('event: b\ndata: 2\n\n');
      res.end();
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as { port: number }).port;
    gw = await startAuthInjectingGateway({ socketPath: sock(), upstreamOrigin: `http://127.0.0.1:${port}`, getAuthHeaders: () => ({}) });
    const res = await request(gw.socketPath, { path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toBe('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
  });

  it('returns 502 when upstream is unreachable', async () => {
    gw = await startAuthInjectingGateway({ socketPath: sock(), upstreamOrigin: 'http://127.0.0.1:1', getAuthHeaders: () => ({}) });
    const res = await request(gw.socketPath, { path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(502);
  });

  it('rejects a percent-encoded traversal without ever contacting upstream (FIX 1)', async () => {
    let upstreamHits = 0;
    upstream = http.createServer((_req, res) => { upstreamHits += 1; res.writeHead(200).end('{}'); });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as { port: number }).port;
    gw = await startAuthInjectingGateway({ socketPath: sock(), upstreamOrigin: `http://127.0.0.1:${port}`, getAuthHeaders: () => ({}) });
    const res = await request(gw.socketPath, { path: '/v1/messages/%2e%2e/organizations', method: 'GET' });
    expect(res.status).toBe(403);
    expect(upstreamHits).toBe(0);
  });

  it('rejects a literal dot-segment traversal via path normalization without contacting upstream (FIX 1)', async () => {
    let upstreamHits = 0;
    upstream = http.createServer((_req, res) => { upstreamHits += 1; res.writeHead(200).end('{}'); });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as { port: number }).port;
    gw = await startAuthInjectingGateway({ socketPath: sock(), upstreamOrigin: `http://127.0.0.1:${port}`, getAuthHeaders: () => ({}) });
    const res = await request(gw.socketPath, { path: '/v1/messages/../organizations', method: 'GET' });
    expect(res.status).toBe(403);
    expect(upstreamHits).toBe(0);
  });

  it('rejects a DOUBLE percent-encoded traversal without ever contacting upstream (FIX 3)', async () => {
    // %252e%252e decodes once to %2e%2e (still encoded — contains no literal %2e/%2f
    // substring and `new URL()` alone won't decode it), and only a second decode pass
    // reveals the `..` segment. A single-decode/blacklist guard misses this.
    let upstreamHits = 0;
    upstream = http.createServer((_req, res) => { upstreamHits += 1; res.writeHead(200).end('{}'); });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as { port: number }).port;
    gw = await startAuthInjectingGateway({ socketPath: sock(), upstreamOrigin: `http://127.0.0.1:${port}`, getAuthHeaders: () => ({}) });
    const res = await request(gw.socketPath, { path: '/v1/messages/%252e%252e/organizations', method: 'GET' });
    expect(res.status).toBe(403);
    expect(upstreamHits).toBe(0);
  });

  it('rejects malformed percent-encoding with 400 without contacting upstream (FIX 3)', async () => {
    let upstreamHits = 0;
    upstream = http.createServer((_req, res) => { upstreamHits += 1; res.writeHead(200).end('{}'); });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as { port: number }).port;
    gw = await startAuthInjectingGateway({ socketPath: sock(), upstreamOrigin: `http://127.0.0.1:${port}`, getAuthHeaders: () => ({}) });
    const res = await request(gw.socketPath, { path: '/v1/messages/%2g', method: 'GET' });
    expect(res.status).toBe(400);
    expect(upstreamHits).toBe(0);
  });

  it('destroys the in-flight upstream request when the client aborts (FIX 2)', async () => {
    const upstreamSocketClosed = new Promise<void>((resolve) => {
      upstream = http.createServer((req) => {
        // Never respond — simulate an upstream that holds the connection open.
        req.socket.on('close', () => resolve());
      });
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    const port = (upstream!.address() as { port: number }).port;
    gw = await startAuthInjectingGateway({ socketPath: sock(), upstreamOrigin: `http://127.0.0.1:${port}`, getAuthHeaders: () => ({}) });

    await new Promise<void>((resolve) => {
      const req = http.request(
        { socketPath: gw!.socketPath, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } },
        () => {},
      );
      req.on('error', () => {}); // destroying the request triggers a benign socket error; swallow it
      req.end('{}');
      setTimeout(() => { req.destroy(); resolve(); }, 50);
    });

    await upstreamSocketClosed;
  });
});

import * as pkg from '../index.js';
it('re-exports the gateway from the package entrypoint', () => {
  expect(typeof pkg.startAuthInjectingGateway).toBe('function');
});
