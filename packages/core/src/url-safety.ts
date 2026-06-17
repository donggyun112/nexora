import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export function normalizePublicHttpUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!isPublicHost(parsed.hostname)) return null;
  return parsed.href;
}

export function isPublicHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPublicIPv4(host);
  if (ipVersion === 6) return isPublicIPv6(host);
  return host.includes('.');
}

function isPublicIPv4(addr: string): boolean {
  const parts = addr.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;          // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;  // private
  if (a === 192 && b === 168) return false;           // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a >= 224) return false;                          // multicast + reserved
  return true;
}

function isPublicIPv6(addr: string): boolean {
  if (addr === '::1' || addr === '::') return false;
  // IPv4-mapped (::ffff:a.b.c.d) / IPv4-compatible (::a.b.c.d) — defer to IPv4 rules.
  const v4Mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPublicIPv4(v4Mapped[1]);
  const v4Compat = addr.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Compat) return isPublicIPv4(v4Compat[1]);
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd]/i.test(addr)) return false;
  if (/^fe[89ab]/i.test(addr)) return false;
  // 64:ff9b::/96 NAT64 to private IPv4 ranges — be conservative, allow only when
  // it's clearly a public IPv4 in the suffix.
  const nat64 = addr.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (nat64) return isPublicIPv4(nat64[1]);
  return true;
}

/**
 * Resolve a hostname and verify every returned IP is public.
 * For URL hosts that are already IP literals, isPublicHost already covered it —
 * this call is a no-op (returns ok). Callers should chain this AFTER isPublicHost.
 */
export async function assertHostResolvesPublic(hostname: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, reason: 'empty hostname' };
  if (isIP(host)) return { ok: true };
  try {
    const records = await lookup(host, { all: true });
    if (records.length === 0) return { ok: false, reason: `dns: no records for ${host}` };
    for (const r of records) {
      if (!isPublicHost(r.address)) {
        return { ok: false, reason: `dns: ${host} resolves to non-public ${r.address}` };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `dns lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface SafeFetchOptions {
  /** Bytes ceiling. Aborts mid-stream when exceeded; rejects if Content-Length already exceeds. */
  readonly maxBytes: number;
  /** Hard wall-clock timeout covering connect + headers + body. */
  readonly timeoutMs: number;
  /** Max redirect hops (default 3). Each hop re-validates public host + DNS. */
  readonly maxRedirects?: number;
  /** Optional fetch override (tests). */
  readonly fetchImpl?: typeof fetch;
}

export interface SafeFetchResult {
  readonly status: number;
  readonly mimeType: string;
  readonly bytes: Buffer;
  readonly finalUrl: string;
}

/**
 * SSRF-aware bounded image fetch:
 *   - http(s) only, host passes isPublicHost AND DNS resolves only to public IPs
 *   - manual redirect handling; each Location re-validated (URL + DNS)
 *   - Content-Length precheck against maxBytes (avoids buffering huge bodies)
 *   - streaming reader stops once maxBytes is exceeded
 *   - single AbortSignal covers connect/headers/body and all redirect hops
 *
 * NOTE: throws on any safety failure (caller wraps in their tool-result errorResult).
 */
export async function safeFetchImageBytes(initialUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let current = initialUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const normalized = normalizePublicHttpUrl(current);
      if (!normalized) throw new Error(`url not public or invalid: ${current}`);
      const parsed = new URL(normalized);
      const dns = await assertHostResolvesPublic(parsed.hostname);
      if (!dns.ok) throw new Error(dns.reason);

      const resp = await fetchImpl(normalized, { signal: controller.signal, redirect: 'manual' });
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) throw new Error(`redirect ${resp.status} without Location header`);
        if (hop === maxRedirects) throw new Error(`too many redirects (>${maxRedirects})`);
        // Drain to free the socket — body is typically empty on redirects but be defensive.
        try { await resp.arrayBuffer(); } catch { /* ignore */ }
        current = new URL(location, normalized).href;
        continue;
      }

      const lenHeader = resp.headers.get('content-length');
      if (lenHeader) {
        const declared = Number(lenHeader);
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          try { await resp.arrayBuffer(); } catch { /* ignore */ }
          throw new Error(`Content-Length ${declared} exceeds cap ${opts.maxBytes}`);
        }
      }

      const mimeType = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const bytes = await readStreamCapped(resp, opts.maxBytes);
      return { status: resp.status, mimeType, bytes, finalUrl: normalized };
    }
    throw new Error(`too many redirects (>${maxRedirects})`);
  } finally {
    clearTimeout(timer);
  }
}

async function readStreamCapped(resp: Response, maxBytes: number): Promise<Buffer> {
  const body = resp.body;
  if (!body) return Buffer.from(await resp.arrayBuffer());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(`response body exceeded cap ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
}
