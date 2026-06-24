/**
 * HostWorkspaceProvider — host-directory backed workspace sessions.
 *
 * This provider gives Nexora a concrete workspace lifecycle boundary, but it is
 * not a hard OS sandbox. For untrusted exec, plug in a provider backed by a
 * container or mount namespace that implements the same WorkspaceProvider
 * contract.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ResolvedWorkspacePath,
  WorkspaceAccessMode,
  WorkspaceAcquireOptions,
  WorkspaceMount,
  WorkspaceProvider,
  WorkspaceResolveOptions,
  WorkspaceSession,
  WorkspaceSnapshot,
} from '@dongkseo/contracts';
import {
  resolveWorkspacePath,
  safeWorkspaceSegment,
  workspaceRootMount,
} from './workspace-path.js';

export interface HostWorkspaceProviderOptions {
  root?: string;
  baseDir?: string;
  perRun?: boolean;
  mode?: WorkspaceAccessMode;
  cleanup?: 'keep' | 'delete';
  mounts?: WorkspaceMount[];
}

export class HostWorkspaceProvider implements WorkspaceProvider {
  private readonly root?: string;
  private readonly baseDir: string;
  private readonly perRun: boolean;
  private readonly mode: WorkspaceAccessMode;
  private readonly cleanupMode: 'keep' | 'delete';
  private readonly mounts: WorkspaceMount[];

  constructor(options: HostWorkspaceProviderOptions = {}) {
    this.root = options.root;
    this.baseDir = options.baseDir ?? path.join(os.tmpdir(), 'nexora-workspaces');
    this.perRun = options.perRun ?? false;
    this.mode = options.mode ?? 'workspace-write';
    this.cleanupMode = options.cleanup ?? (this.perRun ? 'delete' : 'keep');
    this.mounts = options.mounts ?? [];
  }

  async acquire(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    const id = options.runId ?? crypto.randomUUID();
    const root = this.perRun
      ? await this.createRunRoot(id)
      : await this.resolveExistingRoot(options.baseWorkdir);

    return new HostWorkspaceSession({
      id,
      root,
      mode: this.mode,
      cleanupMode: this.cleanupMode,
      mounts: [
        workspaceRootMount(root, this.mode),
        ...this.mounts,
      ],
    });
  }

  private async resolveExistingRoot(baseWorkdir?: string): Promise<string> {
    const selectedRoot = this.root ?? baseWorkdir;
    if (!selectedRoot) {
      throw new Error('HostWorkspaceProvider requires root, baseWorkdir, or perRun: true');
    }
    const root = path.resolve(selectedRoot);
    await fsp.mkdir(root, { recursive: true });
    return fsp.realpath(root);
  }

  private async createRunRoot(id: string): Promise<string> {
    await fsp.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const prefix = path.join(this.baseDir, `${safeWorkspaceSegment(id)}-`);
    return fsp.mkdtemp(prefix);
  }
}

interface HostWorkspaceSessionOptions {
  id: string;
  root: string;
  mode: WorkspaceAccessMode;
  cleanupMode: 'keep' | 'delete';
  mounts: WorkspaceMount[];
}

class HostWorkspaceSession implements WorkspaceSession {
  readonly id: string;
  readonly root: string;
  readonly mode: WorkspaceAccessMode;
  readonly mounts: WorkspaceMount[];
  private readonly cleanupMode: 'keep' | 'delete';
  private cleaned = false;

  constructor(options: HostWorkspaceSessionOptions) {
    this.id = options.id;
    this.root = options.root;
    this.mode = options.mode;
    this.mounts = options.mounts;
    this.cleanupMode = options.cleanupMode;
  }

  async resolve(
    rawPath: string,
    options: WorkspaceResolveOptions = {},
  ): Promise<ResolvedWorkspacePath> {
    return resolveWorkspacePath({
      rawPath,
      root: this.root,
      mode: this.mode,
      mounts: this.mounts,
      access: options.access,
    });
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    return {
      id: this.id,
      backend: 'inline-root',
      root: this.root,
      metadata: { mode: this.mode },
    };
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.cleanupMode === 'delete') {
      await fsp.rm(this.root, { recursive: true, force: true });
    }
  }
}
