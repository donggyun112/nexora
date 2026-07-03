import type { ToolContext, WorkspaceFs, WorkspaceResolveOptions } from '@dongkseo/contracts';
import { createLocalWorkspaceFs } from './local-workspace-fs.js';

export interface ToolPathResolution {
  path: string;
  root: string;
}

export async function resolveToolPath(
  ctx: ToolContext,
  rawPath: string,
  access: WorkspaceResolveOptions['access'],
): Promise<ToolPathResolution> {
  if (!ctx.workspace) {
    return { path: rawPath, root: ctx.workdir };
  }
  const resolved = await ctx.workspace.resolve(rawPath, { access });
  return { path: resolved.path, root: resolved.root };
}

/**
 * The active filesystem runtime for this tool call. Tools use this instead of
 * touching the host fs or the wire, so local/OS-sandboxed/remote backends are a
 * runtime swap rather than per-tool branching:
 * - a backend that exposes its own `fs` (e.g. a remote session) is used as-is;
 * - otherwise a host-filesystem runtime is built, jailed to the session root
 *   (or `ctx.workdir` when there is no session).
 */
export function workspaceFs(ctx: ToolContext): { fs: WorkspaceFs; root: string } {
  if (ctx.workspace?.fs) return { fs: ctx.workspace.fs, root: ctx.workspace.root };
  const session = ctx.workspace;
  const root = session?.root ?? ctx.workdir;
  const base = createLocalWorkspaceFs(root);
  if (!session) return { fs: base, root };
  // Session-aware wrapper: enforce the session's write-access policy (read-only
  // workspace or read-only mount) via its resolve() before a local write, so the
  // tools stay policy-agnostic.
  const fs: WorkspaceFs = {
    readFile: (p) => base.readFile(p),
    stat: (p) => base.stat(p),
    readdir: (p) => base.readdir(p),
    writeFile: async (p, data, opts) => {
      await session.resolve(p, { access: 'write' }); // throws on read-only
      return base.writeFile(p, data, opts);
    },
  };
  return { fs, root };
}
