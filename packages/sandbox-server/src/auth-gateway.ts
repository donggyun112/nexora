import http from 'node:http';
import https from 'node:https';
import fsp from 'node:fs/promises';

const STRIP_HEADERS = new Set(['authorization', 'x-api-key', 'host', 'connection', 'content-length']);

export function isPathAllowed(pathname: string, allowedPrefixes: string[]): boolean {
  if (pathname.includes('..')) return false;
  const path = pathname.split('?')[0];
  return allowedPrefixes.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Deep-decodes `pathname` for the allow/deny DECISION only, then collapses the resulting
 * dot-segments via WHATWG URL parsing. Iterates until decoding stabilizes (capped) so that
 * layered/double percent-encoding (e.g. `%252e%252e` -> `%2e%2e` -> `..`) can't slip past a
 * single-pass decode/blacklist. Throws (URIError) if the input contains malformed
 * percent-encoding, e.g. a bare `%` or `%2g` — callers must treat that as an invalid request.
 *
 * This is intentionally NOT what gets forwarded upstream: forwarding the aggressively-decoded
 * string could change the meaning of a legitimately percent-encoded query value. It exists only
 * to decide whether the request is in-bounds.
 */
function canonicalizePathForDecision(pathname: string, maxIterations = 5): string {
  let current = pathname;
  for (let i = 0; i < maxIterations; i++) {
    const decoded = decodeURIComponent(current); // throws on malformed % sequences
    if (decoded === current) break;
    current = decoded;
  }
  return new URL(current, 'http://gw').pathname;
}

export function sanitizeForwardHeaders(
  incoming: NodeJS.Dict<string | string[]>,
  inject: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    if (STRIP_HEADERS.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  for (const [k, v] of Object.entries(inject)) out[k] = v;
  return out;
}

export interface AuthInjectingGatewayOptions {
  socketPath: string;
  upstreamOrigin: string;
  getAuthHeaders: () => Promise<Record<string, string>> | Record<string, string>;
  allowedPathPrefixes?: string[];
}

export interface AuthInjectingGatewayHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}

export async function startAuthInjectingGateway(
  options: AuthInjectingGatewayOptions,
): Promise<AuthInjectingGatewayHandle> {
  const allowed = options.allowedPathPrefixes ?? ['/v1/messages'];
  const upstream = new URL(options.upstreamOrigin);
  const transport = upstream.protocol === 'http:' ? http : https;
  await fsp.rm(options.socketPath, { force: true });

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
    const rawUrl = req.url ?? '/';

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl, 'http://gw');
    } catch {
      res.writeHead(400).end('gateway: bad request\n');
      return;
    }

    // Canonicalize-then-validate: the allow/deny decision is made against the fully decoded
    // and dot-collapsed path, not the raw (possibly layered-encoded) one — see
    // canonicalizePathForDecision for why a blacklist substring check isn't enough.
    let canonicalPath: string;
    try {
      canonicalPath = canonicalizePathForDecision(parsedUrl.pathname);
    } catch {
      res.writeHead(400).end('gateway: bad request\n');
      return;
    }

    if (!isPathAllowed(canonicalPath, allowed)) {
      res.writeHead(403).end('gateway: path not allowed\n');
      return;
    }
    // Forward the WHATWG-normalized path the client actually sent, never the
    // aggressively-decoded canonicalPath (decoding could change a legitimately-encoded query
    // value's meaning).
    const forwardPath = parsedUrl.pathname + parsedUrl.search;

    const headers = sanitizeForwardHeaders(req.headers, await options.getAuthHeaders());
    const upstreamReq = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'http:' ? 80 : 443),
        method: req.method,
        path: forwardPath,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => { res.destroy(); });
      },
    );
    upstreamReq.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    // Both-ends teardown: don't leave a credential-bearing upstream request in flight once
    // the client side is gone (jail disconnects mid-request, or the response closes early).
    req.on('aborted', () => { upstreamReq.destroy(); });
    res.on('close', () => { if (!res.writableEnded) upstreamReq.destroy(); });
    req.pipe(upstreamReq);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => { server.removeListener('error', reject); resolve(); });
  });

  return {
    socketPath: options.socketPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fsp.rm(options.socketPath, { force: true });
    },
  };
}
