import type { ToolContext, WorkspaceResolveOptions } from '@dongkseo/contracts';

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
