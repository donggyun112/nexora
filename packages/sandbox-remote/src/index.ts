/**
 * @dongkseo/sandbox-remote — remote/cloud `SandboxClient` for the Nexora sandbox
 * wire protocol. Swap it in for a local sandbox client to move the workspace
 * boundary to a provider-managed host without changing the agent or its tools.
 */

export { RemoteSandboxClient, RemoteSandboxError } from './client.js';
export type { RemoteSandboxClientOptions } from './client.js';
