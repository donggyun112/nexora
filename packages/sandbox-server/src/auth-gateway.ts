import http from 'node:http';
import https from 'node:https';
import fsp from 'node:fs/promises';

const STRIP_HEADERS = new Set(['authorization', 'x-api-key', 'host', 'connection', 'content-length']);

export function isPathAllowed(pathname: string, allowedPrefixes: string[]): boolean {
  if (pathname.includes('..')) return false;
  const path = pathname.split('?')[0];
  return allowedPrefixes.some((p) => path === p || path.startsWith(`${p}/`) || pathname.startsWith(`${p}?`));
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
    const url = req.url ?? '/';
    if (!isPathAllowed(url, allowed)) { res.writeHead(403).end('gateway: path not allowed\n'); return; }

    const headers = sanitizeForwardHeaders(req.headers, await options.getAuthHeaders());
    const upstreamReq = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'http:' ? 80 : 443),
        method: req.method,
        path: url,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
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
