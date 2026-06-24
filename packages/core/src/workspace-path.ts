import path from 'node:path';
import type {
  ResolvedWorkspacePath,
  WorkspaceAccessMode,
  WorkspaceMount,
  WorkspaceResolveOptions,
} from '@dongkseo/contracts';
import { resolvePathAgainstRoot } from '@dongkseo/contracts';

export interface ResolveWorkspacePathOptions {
  rawPath: string;
  root: string;
  mode: WorkspaceAccessMode;
  mounts: WorkspaceMount[];
  access?: WorkspaceResolveOptions['access'];
}

export async function resolveWorkspacePath(options: ResolveWorkspacePathOptions): Promise<ResolvedWorkspacePath> {
  const access = options.access ?? 'read';
  const { canonicalRoot: root, finalPath: resolvedPath } = await resolvePathAgainstRoot(
    options.rawPath,
    options.root,
  );
  const relativePath = path.relative(root, resolvedPath);

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
