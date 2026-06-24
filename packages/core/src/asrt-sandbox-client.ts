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
} from '@dongkseo/contracts';
import { safeUtf8Prefix } from '@dongkseo/contracts';
import {
  resolveWorkspacePath,
  safeWorkspaceSegment,
  workspaceRootMount,
} from './workspace-path.js';

export interface AsrtSandboxClientOptions {
  baseDir?: string;
  mode?: WorkspaceAccessMode;
  cleanup?: 'keep' | 'delete';
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
}

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export class AsrtSandboxClient implements SandboxClient, WorkspaceProvider {
  private readonly baseDir: string;
  private readonly mode: WorkspaceAccessMode;
  private readonly cleanupMode: 'keep' | 'delete';
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

  constructor(options: AsrtSandboxClientOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(os.tmpdir(), 'nexora-asrt-workspaces');
    this.mode = options.mode ?? 'workspace-write';
    this.cleanupMode = options.cleanup ?? 'delete';
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
  }

  async acquire(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession> {
    return this.create(options);
  }

  async create(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    const id = options.runId ?? crypto.randomUUID();
    await fsp.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const root = await fsp.mkdtemp(path.join(this.baseDir, `${safeWorkspaceSegment(id)}-`));
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
    });
  }

  async delete(session: WorkspaceSession): Promise<void> {
    await session.cleanup();
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

  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
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
    return spawnAndCollect({
      argv,
      env: mergeSandboxEnv(command.env ?? {}, env),
      cwd: command.cwd ?? this.root,
      timeoutMs: command.timeoutMs,
      signal: command.signal,
      maxOutputBytes: this.maxOutputBytes,
    });
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    return {
      id: this.id,
      root: this.root,
      metadata: {
        mode: this.mode,
        backend: 'asrt',
      },
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
