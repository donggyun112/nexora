import fsp from 'node:fs/promises';
import path from 'node:path';

export class PathOutsideRootError extends Error {
  constructor(
    public readonly target: string,
    public readonly root: string,
  ) {
    super(`Access denied: "${target}" resolves outside workspace root ${root}`);
    this.name = 'PathOutsideRootError';
  }
}

export interface ResolvePathAgainstRootOptions {
  createOutsideRootError?: (target: string, root: string) => Error;
}

export interface ResolvedPathAgainstRoot {
  canonicalRoot: string;
  finalPath: string;
}

export function isPathWithinRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

export async function resolvePathAgainstRoot(
  rawPath: string,
  root: string,
  options: ResolvePathAgainstRootOptions = {},
): Promise<ResolvedPathAgainstRoot> {
  const lexicalRoot = path.resolve(root);
  const canonicalRoot = await fsp.realpath(lexicalRoot);
  const requested = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(canonicalRoot, rawPath);

  if (requested === canonicalRoot || requested === lexicalRoot) {
    return { canonicalRoot, finalPath: canonicalRoot };
  }

  const parent = path.dirname(requested);
  const base = path.basename(requested);

  let parentReal: string;
  try {
    parentReal = await fsp.realpath(parent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    parentReal = await canonicalizeNearestExistingPath(parent);
  }

  const finalPath = path.join(parentReal, base);
  if (!isPathWithinRoot(parentReal, canonicalRoot) || !isPathWithinRoot(finalPath, canonicalRoot)) {
    throw outsideRootError(rawPath, canonicalRoot, options);
  }

  return { canonicalRoot, finalPath };
}

export async function canonicalizeExistingOrNearestPath(requested: string): Promise<string> {
  try {
    return await fsp.realpath(requested);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const parent = path.dirname(requested);
    const parentReal = await canonicalizeNearestExistingPath(parent);
    return path.join(parentReal, path.basename(requested));
  }
}

export async function canonicalizeNearestExistingPath(target: string): Promise<string> {
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

function outsideRootError(
  target: string,
  root: string,
  options: ResolvePathAgainstRootOptions,
): Error {
  return options.createOutsideRootError?.(target, root) ?? new PathOutsideRootError(target, root);
}
