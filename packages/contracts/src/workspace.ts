/**
 * Workspace runtime boundary.
 *
 * A WorkspaceSession is the directory-level execution boundary that tools should
 * use for file and process access. The default host implementation is still a
 * best-effort filesystem boundary; stronger providers can back this contract
 * with containers, mount namespaces, or remote sandboxes.
 */

import type { WorkspaceFs } from './workspace-fs.js';

export type WorkspaceAccessMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type WorkspaceMountAccess = 'ro' | 'rw';

export type WorkspaceMountKind = 'workspace' | 'reference' | 'scratch' | 'grant';

export interface WorkspaceMount {
  name: string;
  target: string;
  source?: string;
  access: WorkspaceMountAccess;
  kind: WorkspaceMountKind;
}

export interface WorkspaceResolveOptions {
  access?: 'read' | 'write' | 'readwrite' | 'list';
}

export interface ResolvedWorkspacePath {
  path: string;
  root: string;
  relativePath: string;
  access: WorkspaceMountAccess;
  mount?: WorkspaceMount;
}

export interface WorkspaceSnapshot {
  id: string;
  /**
   * Persistence backend that owns the archived bytes. `'inline-root'` means the
   * snapshot is only a pointer to a still-live root (no portable archive).
   */
  backend: string;
  /** Backend-specific locator used to restore the archive. Absent for `inline-root`. */
  ref?: string;
  /** Live root, when still on disk — enables fast-path reuse without a restore. */
  root?: string;
  createdAt?: string;
  /**
   * SHA256 of the root's contents at snapshot time. On resume, a live fixed
   * root whose fingerprint still matches lets us skip the restore (hot path);
   * a mismatch (or a fresh per-run root) forces a tar restore (cold path).
   */
  fingerprint?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Pluggable durable persistence for a workspace's bytes.
 *
 * Mirrors the reference SDK's snapshot model (persist / restore / restorable):
 * a snapshot archives the whole workspace root so it survives tmpdir loss and
 * can be rehydrated into a fresh root on a later turn or host. The backend is
 * orthogonal to the OS isolation engine.
 */
export interface SnapshotBackend {
  readonly kind: string;
  /** Archive `rootDir` and persist it under `snapshotId`. Returns the restore ref. */
  persist(snapshotId: string, rootDir: string): Promise<string>;
  /** Restore a previously persisted archive (by `ref`) into `destDir`. */
  restore(ref: string, destDir: string): Promise<void>;
  /** Whether `ref` can be restored right now. */
  restorable(ref: string): Promise<boolean>;
}

/**
 * Reconnect state for a workspace session.
 *
 * This is the faithful analog of the reference SDK's separation between
 * *session state* (how to re-attach to a backend that may still be alive) and a
 * *snapshot* (saved workspace bytes used to seed a fresh session). A local
 * backend has no remote connection, so its session state only carries the
 * `snapshot`; a remote backend additionally carries `ref` — an opaque locator
 * (e.g. `sandboxId@endpoint`) it tries to re-attach to before falling back to
 * rehydrating `snapshot` into a new sandbox.
 *
 * Must be JSON round-trippable so it can be persisted between turns. Provider
 * credentials MUST NOT be serialized into it.
 */
export interface SandboxSessionState {
  /** Backend kind that produced this state (e.g. 'asrt', 'remote'). Routing key for resume. */
  backend: string;
  /** Opaque locator a backend uses to re-attach to a still-live remote session. */
  ref?: string;
  /** Workspace bytes used to recreate + hydrate when re-attach is impossible. */
  snapshot?: WorkspaceSnapshot;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Declarative workspace seeding applied to a *fresh* session only (never over a
 * re-attached or resumed workspace). Unifies mounts and file seeding so the same
 * declaration works across local and remote backends.
 */
export interface WorkspaceManifest {
  mounts?: WorkspaceMount[];
  /** Destinations are workspace-root-relative and must not escape the root. */
  seed?: ReadonlyArray<{ source: string; destSubpath: string }>;
}

export interface SandboxCommand {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxCommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
}

export interface WorkspaceSession {
  id: string;
  root: string;
  /**
   * Host-side backing directory for host-process operations when the logical `root` the agent
   * sees is an in-jail path that does not exist on the server host — e.g. an overlay backend
   * that binds a host dir at `/home/agent`. Absent means `root` IS the host path (asrt/host
   * backends). Two uses, both of which bypass `resolve()`:
   *
   *  1. whole-root byte ops (persist/hydrate tar);
   *  2. the host-side `cwd` for spawning a {@link wrapCommand} result — the jailer process runs
   *     on the host, so it needs a host directory; `root` would be ENOENT. (The *jailed*
   *     process's cwd is unaffected: backends that own it bake it into the wrapped argv.)
   *
   * Per-file reads/writes always go through `resolve()`, which maps to the host backing itself.
   */
  hostRoot?: string;
  mode: WorkspaceAccessMode;
  mounts: WorkspaceMount[];
  /**
   * Filesystem runtime for this workspace. File tools operate through this seam
   * so local, OS-sandboxed, and remote backends differ only by which `WorkspaceFs`
   * implementation is present — not by per-tool branching. When absent, tools
   * fall back to a local filesystem runtime rooted at the session root.
   */
  fs?: WorkspaceFs;
  resolve(path: string, options?: WorkspaceResolveOptions): Promise<ResolvedWorkspacePath>;
  run?(command: SandboxCommand): Promise<SandboxCommandResult>;
  /**
   * 샌드박스 격리를 적용한 argv/env 를 반환한다(실행은 하지 않음). run() 은 결과를 await 하는
   * foreground 모델이라 detached(background) 실행에는 맞지 않으므로, 호출자가 직접 detached
   * spawn 하되 run() 과 동일한 jail(네트워크 차단·비밀 denylist·워크스페이스 격리)을 적용할 수
   * 있게 래핑만 제공한다.
   *
   * Convention — `run()` 을 구현한 세션은 **격리된 것으로 간주한다**. 그런 세션이 `wrapCommand`
   * 를 구현하지 않으면 호출자는 detached spawn 을 **거부해야 한다**: 비격리 폴백은 잽 탈출이다.
   * `run()` 도 `wrapCommand` 도 없는 세션(호스트 워크스페이스)만 날 spawn 이 허용된다.
   *
   * 구현할 수 없는 백엔드가 있다. 이 계약은 잽이 순수한 argv/env 로 표현될 때만 성립하므로,
   * 실행마다 호스트측 준비물(임시 번들·마운트)을 만들고 되돌려야 하는 백엔드(gVisor)나 격리
   * 주체가 원격 서버인 백엔드(remote)는 의도적으로 미구현으로 남긴다 — 반환값에 teardown 훅이
   * 없어 호출자가 정리할 방법이 없기 때문이다.
   *
   * 반환된 argv 는 잽 안 cwd 를 스스로 들고 있다(예: bwrap `--chdir`). 호출자가 spawn 에 넘기는
   * 호스트 cwd 는 그와 무관하며, 논리 root 가 in-jail 경로인 백엔드에서는 {@link hostRoot} 를
   * 써야 한다 — `root` 는 호스트에 존재하지 않을 수 있다.
   */
  wrapCommand?(command: SandboxCommand): Promise<{ argv: string[]; env: Record<string, string | undefined> }>;
  snapshot?(): Promise<WorkspaceSnapshot>;
  /**
   * Reconnect state for this session. Local backends return their snapshot
   * wrapped as `{ backend, snapshot }`; remote backends add a `ref` locator so a
   * later `resume()` can re-attach to the live sandbox. Callers persist this
   * (not the bare snapshot) to survive process/host restarts.
   */
  sessionState?(): Promise<SandboxSessionState>;
  cleanup(): Promise<void>;
}

export interface WorkspaceAcquireOptions {
  baseWorkdir?: string;
  runId?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  /**
   * Externally managed absolute path to root the session at. Unlike
   * `baseWorkdir` (a hint that per-run backends ignore), `rootDir` overrides
   * per-run root minting on every backend: the session lives directly on this
   * directory. The caller owns the directory's lifecycle — backends must not
   * delete it on cleanup nor archive/restore over it (cleanup is forced to
   * 'keep'; servers register the session as non-archivable).
   */
  rootDir?: string;
  /**
   * 워크스페이스 root가 정해진 직후 자동으로 복사해 넣을 디렉토리들(예: 런타임 주입 스킬
   * 디렉토리). 소스가 없거나 읽기 실패해도 acquire/resume 자체는 실패하지 않는다
   * (best-effort). 심볼릭 링크는 복사하지 않는다. 매 acquire/resume마다 다시 적용된다.
   */
  seedDirs?: ReadonlyArray<{ source: string; destSubpath: string }>;
  /**
   * Declarative mounts + seeding applied to a fresh session. A superset home for
   * `seedDirs`/mounts; backends apply it only when creating a new workspace.
   */
  manifest?: WorkspaceManifest;
}

export interface WorkspaceProvider {
  acquire(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>;
}

export interface SandboxClient {
  create(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>;
  /**
   * Resume from reconnect state: re-attach to a still-live backend session when
   * `state.ref` is reachable, otherwise recreate and rehydrate `state.snapshot`.
   */
  resume?(state: SandboxSessionState, options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>;
  delete?(session: WorkspaceSession): Promise<void>;
}
