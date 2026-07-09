/**
 * @dongkseo/sandbox-server — reference implementation of the Nexora sandbox wire
 * protocol. Front any `SandboxClient` backend with HTTP so a remote
 * `@dongkseo/sandbox-remote` client can drive it. See `server.ts` for routes.
 */

export { createSandboxServer } from './server.js';
export type { SandboxServerHandle, SandboxServerOptions } from './server.js';
export { SessionRegistry, type SessionLifecycleOptions } from './session-registry.js';
export { TarArchiveStore, type ArchiveStore, type TarArchiveStoreOptions } from './archive-store.js';
export { OverlayRootfsSandboxClient, buildBwrapArgs, type OverlayRootfsOptions } from './overlay-rootfs-client.js';
export {
  startEgressProxy,
  matchesDomainPattern,
  isEgressAllowed,
  type EgressProxyOptions,
  type EgressProxyHandle,
} from './egress-proxy.js';
export { DurableDirStore } from './durable-dir-store.js';
