import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ResolvedWorkspacePath,
  WorkspaceAccessMode,
  WorkspaceMount,
  WorkspaceResolveOptions,
} from '@dongkseo/contracts';

export interface ResolveWorkspacePathOptions {
  rawPath: string;
  root: string;
  mode: WorkspaceAccessMode;
  mounts: WorkspaceMount[];
  access?: WorkspaceResolveOptions['access'];
}

export async function resolveWorkspacePath(options: ResolveWorkspacePathOptions): Promise<ResolvedWorkspacePath> {
  const access = options.access ?? 'read';
  const root = await fsp.realpath(path.resolve(options.root));
  const requested = path.isAbsolute(options.rawPath)
    ? path.resolve(options.rawPath)
    : path.resolve(root, options.rawPath);
  const resolvedPath = await canonicalizeRequestedPath(requested);
  const relativePath = path.relative(root, resolvedPath);

  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Access denied: "${options.rawPath}" resolves outside workspace root ${root}`);
  }

  const mount = findMount(resolvedPath, options.mounts, root);
  if (isWriteAccess(access)) {
    if (options.mode === 'read-only') {
      throw new Error('Workspace is read-only');
    }
    if (mount?.access === 'ro') {
      throw new Error(`Workspace mount "${mount.name}" is read-only`);
    }
  }

  return {
    path: resolvedPath,
    root,
    relativePath: relativePath || '.',
    access: isWriteAccess(access) ? 'rw' : 'ro',
    mount,
  };
}

async function canonicalizeRequestedPath(requested: string): Promise<string> {
  try {
    return await fsp.realpath(requested);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const parent = path.dirname(requested);
    const parentReal = await canonicalizeNearest(parent);
    return path.join(parentReal, path.basename(requested));
  }
}

async function canonicalizeNearest(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  while (true) {
    try {
      let resolved = await fsp.realpath(current);
      for (let i = missing.length - 1; i >= 0; i--) {
        resolved = path.join(resolved, missing[i]);
      }
      return resolved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function workspaceRootMount(root: string, mode: WorkspaceAccessMode): WorkspaceMount {
  return {
    name: 'workspace',
    target: root,
    source: root,
    access: mode === 'read-only' ? 'ro' : 'rw',
    kind: 'workspace',
  };
}

export function safeWorkspaceSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'run';
}

function isWriteAccess(access: WorkspaceResolveOptions['access']): boolean {
  return access === 'write' || access === 'readwrite';
}

function findMount(
  requested: string,
  mounts: WorkspaceMount[],
  fallbackRoot: string,
): WorkspaceMount | undefined {
  const normalized = mounts.map((mount) => ({
    mount,
    target: path.resolve(mount.target),
  }));
  normalized.sort((a, b) => b.target.length - a.target.length);
  return normalized.find(({ target }) => requested === target || requested.startsWith(target + path.sep))?.mount
    ?? mounts.find((mount) => path.resolve(mount.target) === fallbackRoot);
}
