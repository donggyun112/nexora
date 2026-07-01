/**
 * ASRT-backed local sandbox backend.
 *
 * This is the local implementation of the SandboxClient seam. It delegates OS
 * enforcement to @anthropic-ai/sandbox-runtime while Nexora owns session
 * workspace lifecycle and policy translation.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import type {
  ResolvedWorkspacePath,
  SandboxClient,
  SandboxCommand,
  SandboxCommandResult,
  WorkspaceAccessMode,
  WorkspaceAcquireOptions,
  WorkspaceMount,
  WorkspaceProvider,
  WorkspaceResolveOptions,
  WorkspaceSession,
  WorkspaceSnapshot,
  SnapshotBackend,
} from '@dongkseo/contracts';
import { safeUtf8Prefix } from '@dongkseo/contracts';
import { NoopSnapshotBackend, fingerprintRoot } from './workspace-snapshot.js';
import { materializeSeedDirs } from './workspace-seed.js';
import {
  resolveWorkspacePath,
  safeWorkspaceSegment,
  workspaceRootMount,
} from './workspace-path.js';

export interface AsrtSandboxClientOptions {
  baseDir?: string;
  mode?: WorkspaceAccessMode;
  cleanup?: 'keep' | 'delete';
  /** When false, reuse a fixed root across runs instead of mkdtemp per run. Default true. */
  perRun?: boolean;
  /** Fixed workspace root used when perRun is false (falls back to acquire baseWorkdir). */
  root?: string;
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowRead?: string[];
  denyRead?: string[];
  allowWrite?: string[];
  denyWrite?: string[];
  allowUnixSockets?: string[];
  allowLocalBinding?: boolean;
  mandatoryDenySearchDepth?: number;
  enableWeakerNestedSandbox?: boolean;
  enableWeakerNetworkIsolation?: boolean;
  allowAppleEvents?: boolean;
  mounts?: WorkspaceMount[];
  shell?: string;
  maxOutputBytes?: number;
  /** Durable workspace persistence. Defaults to a no-op (inline-root snapshots). */
  snapshotBackend?: SnapshotBackend;
}

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export class AsrtSandboxClient implements SandboxClient, WorkspaceProvider {
  private readonly baseDir: string;
  private readonly mode: WorkspaceAccessMode;
  private readonly cleanupMode: 'keep' | 'delete';
  private readonly perRun: boolean;
  private readonly root?: string;
  private readonly allowedDomains: string[];
  private readonly deniedDomains: string[];
  private readonly allowRead: string[];
  private readonly denyRead: string[];
  private readonly allowWrite: string[];
  private readonly denyWrite: string[];
  private readonly allowUnixSockets?: string[];
  private readonly allowLocalBinding?: boolean;
  private readonly mandatoryDenySearchDepth?: number;
  private readonly enableWeakerNestedSandbox?: boolean;
  private readonly enableWeakerNetworkIsolation?: boolean;
  private readonly allowAppleEvents?: boolean;
  private readonly mounts: WorkspaceMount[];
  private readonly shell?: string;
  private readonly maxOutputBytes: number;
  private readonly snapshotBackend: SnapshotBackend;

  constructor(options: AsrtSandboxClientOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(os.tmpdir(), 'nexora-asrt-workspaces');
    this.mode = options.mode ?? 'workspace-write';
    this.perRun = options.perRun ?? true;
    this.root = options.root;
    this.cleanupMode = options.cleanup ?? (this.perRun ? 'delete' : 'keep');
    this.allowedDomains = options.allowedDomains ?? [];
    this.deniedDomains = options.deniedDomains ?? [];
    this.allowRead = options.allowRead ?? [];
    this.denyRead = options.denyRead ?? [os.homedir()];
    this.allowWrite = options.allowWrite ?? [];
    this.denyWrite = options.denyWrite ?? ['.env', '.git/hooks', '.mcp.json'];
    this.allowUnixSockets = options.allowUnixSockets;
    this.allowLocalBinding = options.allowLocalBinding;
    this.mandatoryDenySearchDepth = options.mandatoryDenySearchDepth;
    this.enableWeakerNestedSandbox = options.enableWeakerNestedSandbox;
    this.enableWeakerNetworkIsolation = options.enableWeakerNetworkIsolation;
    this.allowAppleEvents = options.allowAppleEvents;
    this.mounts = options.mounts ?? [];
    this.shell = options.shell;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.snapshotBackend = options.snapshotBackend ?? new NoopSnapshotBackend();
  }

  async acquire(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession> {
    return this.create(options);
  }

  async create(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    const id = options.runId ?? crypto.randomUUID();
    const root = this.perRun
      ? await this.createRunRoot(id)
      : await this.resolveExistingRoot(options.baseWorkdir);
    return this.buildSession(id, root, options.seedDirs);
  }

  /**
   * Rehydrate a workspace from a snapshot. With a durable backend, the archived
   * bytes are restored into a fresh root (surviving tmpdir loss between turns);
   * an inline-root snapshot simply reuses the still-live root.
   */
  async resume(state: WorkspaceSnapshot, options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    const id = state.id || crypto.randomUUID();
    const root = this.perRun
      ? await this.createRunRoot(id)
      : await this.resolveExistingRoot(state.root);
    if (state.ref && (await this.snapshotBackend.restorable(state.ref))) {
      // Fixed root may still be live; a per-run root is always fresh (no live fp).
      const live = this.perRun ? undefined : await fingerprintRoot(root);
      if (live !== undefined && live === state.fingerprint) {
        // HOT: live fixed root unchanged since the last snapshot → skip restore.
      } else {
        await this.snapshotBackend.restore(state.ref, root); // COLD
      }
    }
    return this.buildSession(id, root, options.seedDirs);
  }

  async delete(session: WorkspaceSession): Promise<void> {
    await session.cleanup();
  }

  private async buildSession(
    id: string,
    root: string,
    seedDirs?: WorkspaceAcquireOptions['seedDirs'],
  ): Promise<WorkspaceSession> {
    await materializeSeedDirs(root, seedDirs);
    const config = this.buildConfig(root);
    await ensureSandboxManagerInitialized(config);

    return new AsrtSandboxSession({
      id,
      root,
      mode: this.mode,
      config,
      cleanupMode: this.cleanupMode,
      mounts: [
        workspaceRootMount(root, this.mode),
        ...this.mounts,
      ],
      shell: this.shell,
      maxOutputBytes: this.maxOutputBytes,
      snapshotBackend: this.snapshotBackend,
    });
  }

  private async createRunRoot(id: string): Promise<string> {
    await fsp.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    return fsp.mkdtemp(path.join(this.baseDir, `${safeWorkspaceSegment(id)}-`));
  }

  private async resolveExistingRoot(baseWorkdir?: string): Promise<string> {
    const selected = this.root ?? baseWorkdir;
    if (!selected) {
      throw new Error('AsrtSandboxClient requires root, baseWorkdir, or perRun: true');
    }
    const resolved = path.resolve(selected);
    await fsp.mkdir(resolved, { recursive: true, mode: 0o700 });
    return fsp.realpath(resolved);
  }

  private buildConfig(root: string): SandboxRuntimeConfig {
    const writeAllowed = this.mode === 'read-only'
      ? []
      : [...new Set([root, ...this.allowWrite])];

    return {
      network: {
        allowedDomains: this.allowedDomains,
        deniedDomains: this.deniedDomains,
        strictAllowlist: true,
        allowUnixSockets: this.allowUnixSockets,
        allowLocalBinding: this.allowLocalBinding,
      },
      filesystem: {
        denyRead: this.denyRead,
        allowRead: [...new Set([root, ...this.allowRead])],
        allowWrite: writeAllowed,
        denyWrite: this.denyWrite,
      },
      mandatoryDenySearchDepth: this.mandatoryDenySearchDepth,
      enableWeakerNestedSandbox: this.enableWeakerNestedSandbox,
      enableWeakerNetworkIsolation: this.enableWeakerNetworkIsolation,
      allowAppleEvents: this.allowAppleEvents,
    };
  }
}

interface AsrtSandboxSessionOptions {
  id: string;
  root: string;
  mode: WorkspaceAccessMode;
  config: SandboxRuntimeConfig;
  cleanupMode: 'keep' | 'delete';
  mounts: WorkspaceMount[];
  shell?: string;
  maxOutputBytes: number;
  snapshotBackend: SnapshotBackend;
}

class AsrtSandboxSession implements WorkspaceSession {
  readonly id: string;
  readonly root: string;
  readonly mode: WorkspaceAccessMode;
  readonly mounts: WorkspaceMount[];
  private readonly config: SandboxRuntimeConfig;
  private readonly cleanupMode: 'keep' | 'delete';
  private readonly shell?: string;
  private readonly maxOutputBytes: number;
  private readonly snapshotBackend: SnapshotBackend;
  private cleaned = false;

  constructor(options: AsrtSandboxSessionOptions) {
    this.id = options.id;
    this.root = options.root;
    this.mode = options.mode;
    this.config = options.config;
    this.cleanupMode = options.cleanupMode;
    this.mounts = options.mounts;
    this.shell = options.shell;
    this.maxOutputBytes = options.maxOutputBytes;
    this.snapshotBackend = options.snapshotBackend;
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

  async wrapCommand(command: SandboxCommand): Promise<{ argv: string[]; env: Record<string, string | undefined> }> {
    if (command.argv.length === 0) {
      throw new Error('Sandbox command argv must not be empty');
    }
    const cmd = command.argv.map(shellQuote).join(' ');
    const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
      cmd,
      this.shell,
      this.config,
      command.signal,
    );
    return { argv, env: mergeSandboxEnv(command.env ?? {}, env) };
  }

  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    const { argv, env } = await this.wrapCommand(command);
    return spawnAndCollect({
      argv,
      env,
      cwd: command.cwd ?? this.root,
      timeoutMs: command.timeoutMs,
      signal: command.signal,
      maxOutputBytes: this.maxOutputBytes,
    });
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    const createdAt = new Date().toISOString();
    const metadata = { mode: this.mode };
    const fingerprint = await fingerprintRoot(this.root);
    if (this.snapshotBackend.kind === 'noop') {
      // No durable backend: the snapshot only points at the still-live root.
      return { id: this.id, backend: 'inline-root', root: this.root, createdAt, fingerprint, metadata };
    }
    const ref = await this.snapshotBackend.persist(this.id, this.root);
    return {
      id: this.id,
      backend: this.snapshotBackend.kind,
      ref,
      root: this.root,
      createdAt,
      fingerprint,
      metadata,
    };
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    try {
      SandboxManager.cleanupAfterCommand();
    } finally {
      if (this.cleanupMode === 'delete') {
        await fsp.rm(this.root, { recursive: true, force: true });
      }
    }
  }
}

async function ensureSandboxManagerInitialized(config: SandboxRuntimeConfig): Promise<void> {
  if (!SandboxManager.isSupportedPlatform()) {
    throw new Error('ASRT sandboxing is not supported on this platform');
  }
  if (SandboxManager.isSandboxingEnabled()) {
    SandboxManager.updateConfig(config);
    return;
  }
  await SandboxManager.initialize(config);
}

interface SpawnAndCollectOptions {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes: number;
}

function spawnAndCollect(options: SpawnAndCollectOptions): Promise<SandboxCommandResult> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMs)
      : null;
    timer?.unref?.();
    const onAbort = (): void => {
      aborted = true;
      controller.abort();
    };
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = (): void => {
      timer && clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      SandboxManager.cleanupAfterCommand();
    };
    const finish = (result: SandboxCommandResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    if (controller.signal.aborted) {
      finish({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut,
        aborted,
      });
      return;
    }

    const child = spawn(options.argv[0], options.argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      signal: controller.signal,
    });

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const alreadyTruncated = target === 'stdout' ? stdoutTruncated : stderrTruncated;
      if (alreadyTruncated) return;
      const current = target === 'stdout' ? stdout : stderr;
      if (current.length >= options.maxOutputBytes) {
        const safe = safeUtf8Prefix(current, options.maxOutputBytes);
        if (target === 'stdout') {
          stdout = safe;
          stdoutTruncated = true;
        } else {
          stderr = safe;
          stderrTruncated = true;
        }
        return;
      }
      const remaining = options.maxOutputBytes - current.length;
      let next: Buffer<ArrayBufferLike> = Buffer.concat([current, chunk.subarray(0, remaining)]);
      const truncated = chunk.length > remaining;
      if (truncated) next = safeUtf8Prefix(next, next.length);
      if (target === 'stdout') {
        stdout = next;
        stdoutTruncated = truncated;
      } else {
        stderr = next;
        stderrTruncated = truncated;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => {
      if (timedOut || aborted || error.name === 'AbortError') {
        finish({
          exitCode: null,
          signal: null,
          stdout: stdout.toString('utf-8'),
          stderr: stderr.toString('utf-8'),
          timedOut,
          aborted,
        });
      } else {
        fail(error);
      }
    });
    child.on('close', (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        stdout: stdout.toString('utf-8'),
        stderr: stderr.toString('utf-8'),
        timedOut,
        aborted,
      });
    });
  });
}

const ASRT_ENV_KEYS = new Set([
  'SANDBOX_RUNTIME',
  'TMPDIR',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'PIP_CERT',
  'GIT_SSL_CAINFO',
  'AWS_CA_BUNDLE',
  'CARGO_HTTP_CAINFO',
  'DENO_CERT',
  'NO_PROXY',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'GIT_CONFIG_PARAMETERS',
  'GIT_SSH_COMMAND',
  'FTP_PROXY',
  'ftp_proxy',
  'RSYNC_PROXY',
  'DOCKER_HTTP_PROXY',
  'DOCKER_HTTPS_PROXY',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PORT',
  'CLOUDSDK_PROXY_USERNAME',
  'CLOUDSDK_PROXY_PASSWORD',
  'GRPC_PROXY',
  'grpc_proxy',
]);

function mergeSandboxEnv(
  commandEnv: Record<string, string>,
  asrtEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...commandEnv };
  for (const key of ASRT_ENV_KEYS) {
    const value = asrtEnv[key];
    if (value !== undefined && value !== process.env[key]) {
      merged[key] = value;
    }
  }
  return merged;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
