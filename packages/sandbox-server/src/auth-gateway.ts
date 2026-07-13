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
