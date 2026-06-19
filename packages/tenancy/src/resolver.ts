import type { IncomingMessage } from 'node:http';
import { DEFAULT_TENANT } from '@dongkseo/contracts';

/**
 * Resolves the tenant id for an inbound request. Drop-in for
 * `HttpAdapterOptions.resolveTenant`.
 */
export type TenantResolver = (req: IncomingMessage) => string | null;

/**
 * Build a {@link TenantResolver} that reads the tenant from an HTTP header
 * (default: `x-tenant-id`). When the header is missing or blank, it falls back
 * to `fallback` (DEFAULT_TENANT by default).
 *
 * The framework core is tenant-unaware; wiring this into an adapter is how an
 * app opts into multi-tenancy:
 *
 * ```ts
 * import { headerTenantResolver } from '@dongkseo/tenancy';
 * const http = new HttpAdapter({ resolveTenant: headerTenantResolver() });
 * ```
 */
export function headerTenantResolver(
  headerName = 'x-tenant-id',
  fallback: string | null = DEFAULT_TENANT,
): TenantResolver {
  const key = headerName.toLowerCase();
  return (req) => {
    const raw = req.headers[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : fallback;
  };
}
