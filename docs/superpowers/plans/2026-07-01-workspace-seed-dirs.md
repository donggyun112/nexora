# Workspace Seed Dirs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `WorkspaceProvider` acquires (or resumes) a workspace, it automatically copies any declared `seedDirs` into the workspace root before handing the session back — so per-app skill directories (or any other support files) are reachable by the sandboxed `read`/`write`/`edit` tools without the app remembering a separate mirror step.

**Architecture:** Add `seedDirs?: ReadonlyArray<{source, destSubpath}>` to `WorkspaceAcquireOptions` (`@dongkseo/contracts`). A new shared helper `materializeSeedDirs()` in `@dongkseo/core` does the actual best-effort directory copy (skips symlinks, no-ops on a missing source). Both `HostWorkspaceProvider` and `AsrtSandboxClient` call it inside their `acquire()`/`resume()` paths. `LocalExecutionHarness` threads a per-runtime `workspaceSeedDirs` option into the `acquire()` call it already makes. Consumers (`ixpert_manager`, `document-agent`, `in7-marketing-poc`) then pass their skill source(s) as `seedDirs` when constructing `AgentRunner`, instead of hand-rolling a mirror utility.

**Tech Stack:** TypeScript (ESM, Node 26), vitest, pnpm workspaces, `node:fs/promises`.

## Global Constraints

- All new fields are optional — zero behavior change for existing callers that don't pass `seedDirs`.
- Seeding is best-effort: a missing/unreadable source directory must never make `acquire()`/`resume()` throw.
- Symlinks are never followed when copying (a link could point back outside the workspace root).
- Re-seed on every `acquire()` **and** every `resume()` (including the `ContinuousWorkspaceProvider` resume path) — sources may have changed between turns; do not special-case "seed once."
- Follow existing code style in each touched file (this repo's `fsp`-based async fs usage, existing comment density/language — Korean comments are the house style in `packages/core`).
- Reference spec: `docs/superpowers/specs/2026-07-01-workspace-seed-dirs-design.md`.

---

### Task 1: `materializeSeedDirs` helper in `@dongkseo/core`

**Files:**
- Create: `packages/core/src/workspace-seed.ts`
- Test: `packages/core/src/__tests__/workspace-seed.test.ts`

**Interfaces:**
- Produces: `export interface WorkspaceSeedEntry { readonly source: string; readonly destSubpath: string; }` and `export async function materializeSeedDirs(root: string, seedDirs?: ReadonlyArray<WorkspaceSeedEntry>): Promise<void>`. Later tasks import both from `./workspace-seed.js`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/workspace-seed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { materializeSeedDirs } from '../workspace-seed.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('materializeSeedDirs', () => {
  it('copies a source directory into <root>/<destSubpath>', async () => {
    const source = await makeTempDir('seed-src-');
    await fsp.mkdir(path.join(source, 'my-skill'), { recursive: true });
    await fsp.writeFile(path.join(source, 'my-skill', 'SKILL.md'), '# hello');

    const root = await makeTempDir('seed-root-');
    await materializeSeedDirs(root, [{ source, destSubpath: 'skills' }]);

    const copied = await fsp.readFile(path.join(root, 'skills', 'my-skill', 'SKILL.md'), 'utf-8');
    expect(copied).toBe('# hello');
  });

  it('skips symlinks instead of following them', async () => {
    const source = await makeTempDir('seed-src-');
    const outside = await makeTempDir('seed-outside-');
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'do not copy');
    await fsp.symlink(path.join(outside, 'secret.txt'), path.join(source, 'link.txt'));
    await fsp.writeFile(path.join(source, 'real.txt'), 'copy me');

    const root = await makeTempDir('seed-root-');
    await materializeSeedDirs(root, [{ source, destSubpath: 'out' }]);

    await expect(fsp.access(path.join(root, 'out', 'link.txt'))).rejects.toThrow();
    const real = await fsp.readFile(path.join(root, 'out', 'real.txt'), 'utf-8');
    expect(real).toBe('copy me');
  });

  it('no-ops silently when the source directory does not exist', async () => {
    const root = await makeTempDir('seed-root-');
    await expect(
      materializeSeedDirs(root, [{ source: '/no/such/path', destSubpath: 'skills' }]),
    ).resolves.toBeUndefined();
    await expect(fsp.access(path.join(root, 'skills'))).rejects.toThrow();
  });

  it('no-ops when seedDirs is undefined or empty', async () => {
    const root = await makeTempDir('seed-root-');
    await expect(materializeSeedDirs(root, undefined)).resolves.toBeUndefined();
    await expect(materializeSeedDirs(root, [])).resolves.toBeUndefined();
  });

  it('re-copies on every call (overwrites stale content)', async () => {
    const source = await makeTempDir('seed-src-');
    await fsp.writeFile(path.join(source, 'a.txt'), 'v1');
    const root = await makeTempDir('seed-root-');

    await materializeSeedDirs(root, [{ source, destSubpath: 'out' }]);
    await fsp.writeFile(path.join(source, 'a.txt'), 'v2');
    await materializeSeedDirs(root, [{ source, destSubpath: 'out' }]);

    const content = await fsp.readFile(path.join(root, 'out', 'a.txt'), 'utf-8');
    expect(content).toBe('v2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run workspace-seed`
Expected: FAIL — `Cannot find module '../workspace-seed.js'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/workspace-seed.ts`:

```ts
/**
 * materializeSeedDirs — 워크스페이스 root가 정해진 직후, WorkspaceAcquireOptions.seedDirs로
 * 선언된 디렉토리들을 root 안으로 복사한다. 소스가 없거나 읽기 실패해도 조용히 skip한다
 * (best-effort — 지원 파일이 없어도 에이전트는 정상 동작해야 한다). 심볼릭 링크는 절대
 * 따라가지 않는다(워크스페이스 밖을 가리키는 링크가 root-jail을 무력화하지 않도록).
 *
 * 매 acquire()/resume() 마다 다시 호출돼 최신 소스로 덮어쓴다 — "최초 1회만 seed"는 소스가
 * 대화 중간에 갱신될 때 stale 콘텐츠를 남긴다.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

export interface WorkspaceSeedEntry {
  /** 복사할 소스 디렉토리(절대/상대 모두 허용, 내부적으로 resolve). */
  readonly source: string;
  /** 워크스페이스 root 기준 목적지 상대경로. */
  readonly destSubpath: string;
}

export async function materializeSeedDirs(
  root: string,
  seedDirs?: ReadonlyArray<WorkspaceSeedEntry>,
): Promise<void> {
  if (!seedDirs || seedDirs.length === 0) return;
  for (const entry of seedDirs) {
    await materializeSeedDir(root, entry);
  }
}

async function materializeSeedDir(root: string, entry: WorkspaceSeedEntry): Promise<void> {
  const source = path.resolve(entry.source);
  if (!(await isDirectory(source))) return;

  const dest = path.join(root, entry.destSubpath);
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.cp(source, dest, {
    recursive: true,
    force: true,
    filter: async (src: string) => {
      try {
        return !(await fsp.lstat(src)).isSymbolicLink();
      } catch {
        return false;
      }
    },
  });
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run workspace-seed`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
cd /Users/dongkseo99/work/nexora
git add packages/core/src/workspace-seed.ts packages/core/src/__tests__/workspace-seed.test.ts
git commit -m "feat(core): add materializeSeedDirs workspace-seeding helper"
```

---

### Task 2: Add `seedDirs` to `WorkspaceAcquireOptions` (`@dongkseo/contracts`)

**Files:**
- Modify: `packages/contracts/src/workspace.ts:110-119` (the `WorkspaceAcquireOptions` and `SandboxClient` interfaces)

**Interfaces:**
- Consumes: nothing new.
- Produces: `WorkspaceAcquireOptions.seedDirs?: ReadonlyArray<{ source: string; destSubpath: string }>`, and `SandboxClient.resume?` now accepts a second `options` parameter. Task 3/4 read `options.seedDirs`.

- [ ] **Step 1: Edit `WorkspaceAcquireOptions` and `SandboxClient`**

In `packages/contracts/src/workspace.ts`, replace:

```ts
export interface WorkspaceAcquireOptions {
  baseWorkdir?: string;
  runId?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceProvider {
  acquire(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>;
}

export interface SandboxClient {
  create(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>;
  resume?(state: WorkspaceSnapshot): Promise<WorkspaceSession>;
  delete?(session: WorkspaceSession): Promise<void>;
}
```

with:

```ts
export interface WorkspaceAcquireOptions {
  baseWorkdir?: string;
  runId?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  /**
   * 워크스페이스 root가 정해진 직후 자동으로 복사해 넣을 디렉토리들(예: 런타임 주입 스킬
   * 디렉토리). 소스가 없거나 읽기 실패해도 acquire/resume 자체는 실패하지 않는다
   * (best-effort). 심볼릭 링크는 복사하지 않는다. 매 acquire/resume마다 다시 적용된다.
   */
  seedDirs?: ReadonlyArray<{ source: string; destSubpath: string }>;
}

export interface WorkspaceProvider {
  acquire(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>;
}

export interface SandboxClient {
  create(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>;
  resume?(state: WorkspaceSnapshot, options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>;
  delete?(session: WorkspaceSession): Promise<void>;
}
```

- [ ] **Step 2: Build to verify no type errors**

Run: `cd packages/contracts && pnpm run build`
Expected: succeeds (this is a pure additive/optional-field change — no existing caller breaks).

- [ ] **Step 3: Commit**

```bash
cd /Users/dongkseo99/work/nexora
git add packages/contracts/src/workspace.ts
git commit -m "feat(contracts): add seedDirs to WorkspaceAcquireOptions"
```

---

### Task 3: Wire seeding into `HostWorkspaceProvider`

**Files:**
- Modify: `packages/core/src/workspace-provider.ts:56-72` (`HostWorkspaceProvider.acquire`)
- Test: `packages/core/src/__tests__/workspace-provider.test.ts` (existing file — add a case)

**Interfaces:**
- Consumes: `materializeSeedDirs` from `./workspace-seed.js` (Task 1), `WorkspaceAcquireOptions.seedDirs` (Task 2).

- [ ] **Step 1: Write the failing test**

Read the existing `packages/core/src/__tests__/workspace-provider.test.ts` first to match its exact style, then append this case inside the existing `describe('HostWorkspaceProvider', ...)` block:

```ts
  it('materializes seedDirs into the acquired root', async () => {
    const seedSource = await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-src-'));
    await fsp.writeFile(path.join(seedSource, 'SKILL.md'), '# seeded');

    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-ws-'));
    const provider = new HostWorkspaceProvider({ baseDir, perRun: true });
    const session = await provider.acquire({
      seedDirs: [{ source: seedSource, destSubpath: '.skill_refs' }],
    });

    const seeded = await fsp.readFile(path.join(session.root, '.skill_refs', 'SKILL.md'), 'utf-8');
    expect(seeded).toBe('# seeded');
  });
```

(Add `import fsp from 'node:fs/promises';`, `import os from 'node:os';`, `import path from 'node:path';` to the test file's imports if not already present — check first, this file likely already imports some of these given it exercises a filesystem-backed provider.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run workspace-provider`
Expected: FAIL — seeded file not found (`ENOENT`), since `acquire()` doesn't call `materializeSeedDirs` yet.

- [ ] **Step 3: Wire the call**

In `packages/core/src/workspace-provider.ts`, add the import:

```ts
import { materializeSeedDirs } from './workspace-seed.js';
```

Replace the `acquire` method body:

```ts
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
```

with:

```ts
  async acquire(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    const id = options.runId ?? crypto.randomUUID();
    const root = this.perRun
      ? await this.createRunRoot(id)
      : await this.resolveExistingRoot(options.baseWorkdir);
    await materializeSeedDirs(root, options.seedDirs);

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run workspace-provider`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/dongkseo99/work/nexora
git add packages/core/src/workspace-provider.ts packages/core/src/__tests__/workspace-provider.test.ts
git commit -m "feat(core): HostWorkspaceProvider materializes seedDirs on acquire"
```

---

### Task 4: Wire seeding into `AsrtSandboxClient` (acquire + resume)

**Files:**
- Modify: `packages/core/src/asrt-sandbox-client.ts:116-172` (`acquire`, `create`, `resume`, `buildSession`)
- Modify: `packages/core/src/continuous-workspace-provider.ts` (`ResumableWorkspaceProvider.resume` signature, `acquire()`'s resume call)
- Test: `packages/core/src/__tests__/asrt-sandbox-client.test.ts` (existing) and `packages/core/src/__tests__/continuous-workspace-provider.test.ts` (existing)

**Interfaces:**
- Consumes: `materializeSeedDirs` (Task 1), `WorkspaceAcquireOptions.seedDirs` (Task 2).
- Produces: `ResumableWorkspaceProvider.resume(state, options?)` — Task 6-9 (consumer wiring) rely on `seedDirs` flowing through both fresh-acquire and resume paths.

- [ ] **Step 1: Write the failing test for `AsrtSandboxClient`**

Read `packages/core/src/__tests__/asrt-sandbox-client.test.ts` first to match its existing setup/mocking style (it likely stubs `@anthropic-ai/sandbox-runtime`'s `SandboxManager`). Add a case that constructs a client with `perRun: true` and asserts a seeded file lands under the acquired session's `root`:

```ts
  it('materializes seedDirs on acquire', async () => {
    const seedSource = await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-src-'));
    await fsp.writeFile(path.join(seedSource, 'SKILL.md'), '# seeded');

    const client = new AsrtSandboxClient({ perRun: true, baseDir: await fsp.mkdtemp(path.join(os.tmpdir(), 'asrt-base-')) });
    const session = await client.acquire({
      seedDirs: [{ source: seedSource, destSubpath: '.skill_refs' }],
    });

    const seeded = await fsp.readFile(path.join(session.root, '.skill_refs', 'SKILL.md'), 'utf-8');
    expect(seeded).toBe('# seeded');
  });

  it('materializes seedDirs on resume', async () => {
    const seedSource = await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-src-'));
    await fsp.writeFile(path.join(seedSource, 'SKILL.md'), '# v1');

    const client = new AsrtSandboxClient({ perRun: true, baseDir: await fsp.mkdtemp(path.join(os.tmpdir(), 'asrt-base-')) });
    const first = await client.acquire({ seedDirs: [{ source: seedSource, destSubpath: '.skill_refs' }] });
    const snap = await first.snapshot!();

    await fsp.writeFile(path.join(seedSource, 'SKILL.md'), '# v2');
    const resumed = await client.resume(snap, { seedDirs: [{ source: seedSource, destSubpath: '.skill_refs' }] });

    const seeded = await fsp.readFile(path.join(resumed.root, '.skill_refs', 'SKILL.md'), 'utf-8');
    expect(seeded).toBe('# v2');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && pnpm vitest run asrt-sandbox-client`
Expected: FAIL on both new cases — `.skill_refs/SKILL.md` not found, and `resume()` doesn't accept a second argument yet (TS error if strict, otherwise silently ignored — either way the file won't exist).

- [ ] **Step 3: Wire `materializeSeedDirs` through `create`, `resume`, `buildSession`**

In `packages/core/src/asrt-sandbox-client.ts`, add the import:

```ts
import { materializeSeedDirs } from './workspace-seed.js';
```

Replace lines 116–148 (the `acquire`/`create`/`resume` methods) and line 154 (`buildSession` signature):

```ts
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
```

- [ ] **Step 4: Update `ResumableWorkspaceProvider` and `ContinuousWorkspaceProvider.acquire()`**

In `packages/core/src/continuous-workspace-provider.ts`, replace:

```ts
export interface ResumableWorkspaceProvider extends WorkspaceProvider {
  resume(state: WorkspaceSnapshot): Promise<WorkspaceSession>;
}
```

with:

```ts
export interface ResumableWorkspaceProvider extends WorkspaceProvider {
  resume(state: WorkspaceSnapshot, options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>;
}
```

and inside `acquire()`, replace:

```ts
    let session: WorkspaceSession;
    if (prior) {
      try {
        session = await this.inner.resume(prior);
      } catch (err) {
        this.warn('workspace resume failed; acquiring fresh', err);
        session = await this.inner.acquire(options);
      }
    } else {
      session = await this.inner.acquire(options);
    }
```

with:

```ts
    let session: WorkspaceSession;
    if (prior) {
      try {
        session = await this.inner.resume(prior, options);
      } catch (err) {
        this.warn('workspace resume failed; acquiring fresh', err);
        session = await this.inner.acquire(options);
      }
    } else {
      session = await this.inner.acquire(options);
    }
```

- [ ] **Step 5: Update the existing `continuous-workspace-provider.test.ts` mocks**

Read the file first — its `inner` mocks currently define `resume: vi.fn(async () => makeSession('fresh'))` with zero args. Update each mock's `resume` signature to accept `(state, options?)` (a no-op signature widening — `vi.fn(async (_state, _options) => makeSession('fresh'))`) so a later assertion can be added:

```ts
  it('passes seedDirs through on resume', async () => {
    const store = { load: vi.fn(async () => ({ id: 'x', backend: 'inline-root' })), save: vi.fn() };
    const inner = {
      acquire: vi.fn(async () => makeSession('fresh')),
      resume: vi.fn(async () => makeSession('resumed')),
    };
    const provider = new ContinuousWorkspaceProvider(inner as any, store as any, 'conv-1');

    const seedDirs = [{ source: '/tmp/x', destSubpath: '.skill_refs' }];
    await provider.acquire({ seedDirs });

    expect(inner.resume).toHaveBeenCalledWith({ id: 'x', backend: 'inline-root' }, { seedDirs });
  });
```

Add this as a new `it(...)` inside the existing `describe('ContinuousWorkspaceProvider', ...)` block.

- [ ] **Step 6: Run all affected tests to verify they pass**

Run: `cd packages/core && pnpm vitest run asrt-sandbox-client continuous-workspace-provider`
Expected: PASS — all cases including the two new ones per file.

- [ ] **Step 7: Run the full core test suite to check for regressions**

Run: `cd packages/core && pnpm test`
Expected: PASS, 0 failures (existing `resume(prior)` single-arg call sites elsewhere in the suite still work since the new `options` parameter is optional).

- [ ] **Step 8: Commit**

```bash
cd /Users/dongkseo99/work/nexora
git add packages/core/src/asrt-sandbox-client.ts packages/core/src/continuous-workspace-provider.ts packages/core/src/__tests__/asrt-sandbox-client.test.ts packages/core/src/__tests__/continuous-workspace-provider.test.ts
git commit -m "feat(core): AsrtSandboxClient + ContinuousWorkspaceProvider thread seedDirs through resume"
```

---

### Task 5: Thread `workspaceSeedDirs` through `LocalExecutionHarness`

**Files:**
- Modify: `packages/core/src/execution-harness.ts:42-78` (`LocalExecutionHarnessOptions`), `:128-144` (constructor), `:185-188` (the `acquire()` call site)
- Test: `packages/core/src/__tests__/runner.test.ts` (existing — uses a fake `WorkspaceProvider`)

**Interfaces:**
- Consumes: `WorkspaceAcquireOptions.seedDirs` (Task 2).
- Produces: `AgentRunnerOptions.workspaceSeedDirs?: WorkspaceAcquireOptions['seedDirs']` — Task 6-9 (consumer apps) pass this when constructing `AgentRunner`.

- [ ] **Step 1: Write the failing test**

Read `packages/core/src/__tests__/runner.test.ts` first (it already builds a fake `WorkspaceProvider` and asserts on how `acquire` was called — mirror that pattern). Add:

```ts
  it('forwards workspaceSeedDirs into workspaceProvider.acquire', async () => {
    const acquireCalls: unknown[] = [];
    const provider: WorkspaceProvider = {
      acquire: async (options) => {
        acquireCalls.push(options);
        return {
          id: 'w1',
          root: '/tmp/w1',
          mode: 'workspace-write',
          mounts: [],
          resolve: async (p) => ({ path: p, root: '/tmp/w1', relativePath: p, access: 'rw' }),
          cleanup: async () => {},
        };
      },
    };

    // Build the harness the same way the existing "workspaceProvider" test in this
    // file does (same architecture/llm/tools fakes) but pass workspaceSeedDirs.
    const harness = new LocalExecutionHarness({
      architecture: fakeArchitecture, // reuse the fake already defined earlier in this test file
      llm: fakeLlm,
      tools: fakeContextfulTools,
      workspaceProvider: provider,
      workspaceSeedDirs: [{ source: '/tmp/skills', destSubpath: '.skill_refs' }],
    });

    const gen = harness.execute({ role: 'user', content: 'hi' } as any);
    for await (const _ of gen) { /* drain */ }

    expect(acquireCalls[0]).toMatchObject({
      seedDirs: [{ source: '/tmp/skills', destSubpath: '.skill_refs' }],
    });
  });
```

Note: `fakeArchitecture`, `fakeLlm`, `fakeContextfulTools` must match whatever fakes the existing test file already declares near its top (this file already has a working `workspaceProvider` test — reuse its exact fixtures rather than inventing new ones, to keep the new test consistent with file conventions).

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && pnpm vitest run runner`
Expected: FAIL — `acquireCalls[0]` has no `seedDirs` key (harness doesn't have `workspaceSeedDirs` option yet; TS compile may also fail on the unknown option depending on `tsconfig` strictness in the test file).

- [ ] **Step 3: Add the option, field, and wiring**

In `packages/core/src/execution-harness.ts`, in `LocalExecutionHarnessOptions` (after the `workspaceProvider?: WorkspaceProvider;` line), add:

```ts
  /** Per-runtime seed dirs forwarded into workspaceProvider.acquire(). See WorkspaceAcquireOptions.seedDirs. */
  workspaceSeedDirs?: WorkspaceAcquireOptions['seedDirs'];
```

Add `WorkspaceAcquireOptions` to the `import type { ... } from '@dongkseo/contracts';` block at the top of the file (it currently imports `WorkspaceProvider, WorkspaceSession` but not `WorkspaceAcquireOptions`).

In the class body, add a field next to `private readonly workspaceProvider?: WorkspaceProvider;`:

```ts
  private readonly workspaceSeedDirs?: WorkspaceAcquireOptions['seedDirs'];
```

In the constructor, next to `this.workspaceProvider = options.workspaceProvider;`, add:

```ts
    this.workspaceSeedDirs = options.workspaceSeedDirs;
```

Replace the `acquire()` call site:

```ts
        workspace = await this.workspaceProvider.acquire({
          baseWorkdir: baseToolContext.workdir,
          input,
        });
```

with:

```ts
        workspace = await this.workspaceProvider.acquire({
          baseWorkdir: baseToolContext.workdir,
          input,
          seedDirs: this.workspaceSeedDirs,
        });
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && pnpm vitest run runner`
Expected: PASS.

- [ ] **Step 5: Run the full core suite**

Run: `cd packages/core && pnpm test`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
cd /Users/dongkseo99/work/nexora
git add packages/core/src/execution-harness.ts packages/core/src/__tests__/runner.test.ts
git commit -m "feat(core): AgentRunner forwards workspaceSeedDirs to workspaceProvider.acquire"
```

---

### Task 6: Full monorepo build/test + version bump (nexora)

**Files:**
- Modify: `packages/contracts/package.json` (version), `packages/core/package.json` (version + its `@dongkseo/contracts` dependency range if pinned)

- [ ] **Step 1: Run the full monorepo build and test**

Run: `cd /Users/dongkseo99/work/nexora && pnpm -r build && pnpm -r test`
Expected: PASS, 0 failures (this is the same gate ADR-001's rollout used — "전체 모노레포 green").

- [ ] **Step 2: Bump versions**

Bump `packages/contracts/package.json` `version` (currently check the file for its current value) by a patch/minor per this repo's existing convention (features that are purely additive/optional typically bump minor — check the last few version bumps in `packages/contracts/CHANGELOG.md` or git log for the pattern actually used; match it). Bump `packages/core/package.json` `version` the same way, and if `packages/core/package.json`'s dependency on `@dongkseo/contracts` is version-pinned (not `workspace:^`), bump that too.

- [ ] **Step 3: Commit the version bump**

```bash
cd /Users/dongkseo99/work/nexora
git add packages/contracts/package.json packages/core/package.json
git commit -m "chore(release): bump contracts + core for seedDirs workspace feature"
```

- [ ] **Step 4: STOP — confirm before publishing**

Publishing to the public npm registry is not easily reversible. **Do not run the publish command without the user's explicit go-ahead in this session.** Once confirmed, follow this repo's existing release process (check `package.json` root scripts or `docs/architecture/` for a documented `pnpm publish` / changesets flow — do not guess a command that hasn't been verified to exist in this repo).

---

### Task 7: `ixpert_manager` — wire `seedDirs`, point skill_manage at the mirrored path

**Files:**
- Modify: `/Users/dongkseo99/work/ixpert_manager/package.json` (bump `@dongkseo/core`, `@dongkseo/contracts` to the versions published in Task 6)
- Modify: `/Users/dongkseo99/work/ixpert_manager/src/runtime/compose.ts` (the `createRuntime` closure — `skillsDir` resolution and the `AgentRunner` construction)

**Interfaces:**
- Consumes: `AgentRunnerOptions.workspaceSeedDirs` (Task 5, published via Task 6).

- [ ] **Step 1: Bump nexora deps**

Edit `ixpert_manager/package.json`: set `"@dongkseo/core"` and `"@dongkseo/contracts"` (if listed as a direct dependency — check first; it may only be a transitive dep of `@dongkseo/architectures`/`@dongkseo/tools`, in which case bump whichever direct dependency's range needs widening to pull the new core version) to `^<new-version>` from Task 6.

Run: `cd /Users/dongkseo99/work/ixpert_manager && pnpm install`
Expected: lockfile updates to resolve the new `@dongkseo/core`/`@dongkseo/contracts` version — confirm via `git diff pnpm-lock.yaml` that the version actually bumped (per this project's own recorded gotcha: a `^` range does not auto-pull a new release until `pnpm install` runs again).

- [ ] **Step 2: Compute `seedDirs` and pass to `AgentRunner`**

In `src/runtime/compose.ts`, inside the `createRuntime` closure, find the line:

```ts
    const skillsDir = runtimeSkillsDir ?? envelope?.metadata?.runtimeSkillsDir;
```

Immediately after it, add:

```ts
    const workspaceSeedDirs = skillsDir
      ? [{ source: skillsDir, destSubpath: '.skill_refs/runtime/skills' }]
      : undefined;
    // skill_manage 와 buildRuntimeSkillReferenceMenu 는 이제 원본이 아니라 워크스페이스
    // 안으로 미러링된 경로를 봐야 한다 — 그래야 postProcessSkillBody 가 심는 절대경로가
    // 워크스페이스 root 안이라 read/exec 도구로 실제로 열린다.
    const mirroredSkillsDir = workspaceSeedDirs
      ? path.join(scopedWorkdir, '.skill_refs/runtime/skills')
      : undefined;
```

Then find `const skillMenu = skillsDir ? buildRuntimeSkillReferenceMenu(skillsDir) : undefined;` and change it to:

```ts
    const skillMenu = mirroredSkillsDir ? buildRuntimeSkillReferenceMenu(mirroredSkillsDir) : undefined;
```

Find `createSkillManageTool(skillsDir),` (inside the `tools:` array passed to `CoreToolExecutor`) and change it to:

```ts
          createSkillManageTool(mirroredSkillsDir),
```

Finally, find the `return new AgentRunner({` call (the main one, not `buildSubagentRuntime`'s) and add `workspaceSeedDirs,` to its options object, alongside the existing `workspaceProvider: convId ? new ContinuousWorkspaceProvider(...) : sandboxProvider,` line.

**Important ordering note:** `mirroredSkillsDir` must be computed as a path (string), but the actual copy only happens later, inside `workspaceProvider.acquire()`, which `AgentRunner`'s internal harness calls when `.execute()` runs — by the time the agent's first tool call resolves `mirroredSkillsDir`, the copy has already completed (acquire happens before any tool executes). This ordering is safe by construction; no explicit wait is needed in `compose.ts`.

- [ ] **Step 3: Verify types**

Run: `cd /Users/dongkseo99/work/ixpert_manager && pnpm run lint`
Expected: PASS, 0 type errors.

- [ ] **Step 4: Run tests**

Run: `cd /Users/dongkseo99/work/ixpert_manager && pnpm test`
Expected: PASS. If existing tests assert on `createSkillManageTool(skillsDir)` being called with the raw `runtimeSkillsDir`, update those assertions to expect the mirrored path instead — read `src/tools/__tests__/skill.tool.test.ts` (or wherever such a test lives; grep for `createSkillManageTool` in `src/**/*.test.ts` first) before assuming none exist.

- [ ] **Step 5: Commit**

```bash
cd /Users/dongkseo99/work/ixpert_manager
git add package.json pnpm-lock.yaml src/runtime/compose.ts
git commit -m "feat(skills): mirror runtime skills into sandbox workspace via seedDirs"
```

---

### Task 8: `document-agent` — introduce `skill_manage` + wire `seedDirs`

**Files:**
- Modify: `/Users/dongkseo99/work/document-agent/package.json` (bump `@dongkseo/core`/`@dongkseo/contracts`)
- Create: `/Users/dongkseo99/work/document-agent/src/skill.tool.ts` (ported from `ixpert_manager/src/tools/skill.tool.ts` verbatim — same package deps, `@dongkseo/skills` is already a transitive availability since `@dongkseo/core`/`@dongkseo/architectures` depend on it; confirm `@dongkseo/skills` is resolvable from `document-agent`'s lockfile before relying on it — if not present as a direct dependency, add it to `package.json`)
- Modify: `/Users/dongkseo99/work/document-agent/src/runtime/compose.ts` (destructure and use `runtimeSkillsDir`, add `workspaceSeedDirs`, register the new tool)
- Modify: `/Users/dongkseo99/work/document-agent/src/pi-cli.ts` (confirm it already passes `runtimeSkillsDir`/`envelope.metadata.runtimeSkillsDir` — per prior investigation it already resolves `.pi/skills` at `pi-cli.ts:146`, so likely only `compose.ts` needs to start consuming what's already being passed)

**Interfaces:**
- Consumes: `AgentRunnerOptions.workspaceSeedDirs` (Task 5).
- Produces: `skill_manage` tool now present in `document-agent`'s tool list (new — check `context/` or wherever tool-name allowlists live, e.g. `contextLoader`'s `defaultTools`, so the new tool is actually exposed to the card/context and not just registered-but-invisible).

- [ ] **Step 1: Bump nexora deps**

Same as Task 7 Step 1, for `document-agent/package.json`.

Run: `cd /Users/dongkseo99/work/document-agent && pnpm install` and confirm the lockfile bump.

- [ ] **Step 2: Port `skill.tool.ts`**

Copy `/Users/dongkseo99/work/ixpert_manager/src/tools/skill.tool.ts` to `/Users/dongkseo99/work/document-agent/src/skill.tool.ts` unchanged (it has no ixpert-specific imports — it only depends on `node:fs/promises`, `node:path`, `@dongkseo/contracts`, and `@dongkseo/skills`). Adjust the relative import path if `document-agent`'s directory layout differs (it does not have a `src/tools/` subdirectory today — place it at `src/skill.tool.ts` next to `src/outline-tools.ts`, matching this repo's flatter layout).

- [ ] **Step 3: Wire it into `compose.ts`**

In `document-agent/src/runtime/compose.ts`, add the import:

```ts
import { createSkillManageTool } from '../skill.tool.js';
```

The `createRuntime` closure's destructured parameters already declare `runtimeSkillsDir` in its type signature but never bind it (see the current code: the destructuring pattern is `{ context, middlewares, memory, transcript, conversationId, envelope, aliasStore: providedAliasStore }` — `runtimeSkillsDir` is typed but not destructured). Change the destructuring to bind it:

```ts
  const createRuntime = ({
    context,
    middlewares,
    memory,
    transcript,
    conversationId,
    envelope,
    aliasStore: providedAliasStore,
    runtimeSkillsDir,
  }: {
```

(keep the rest of the type annotation identical). Then, after the `convId` computation (`const convId = conversationId ?? envelope?.metadata?.conversationId;`), add:

```ts
    const skillsDir = runtimeSkillsDir ?? envelope?.metadata?.runtimeSkillsDir;
    const workspaceSeedDirs = skillsDir
      ? [{ source: skillsDir, destSubpath: '.skill_refs/runtime/skills' }]
      : undefined;
    const mirroredSkillsDir = workspaceSeedDirs
      ? path.join(runtimeWorkdir, '.skill_refs/runtime/skills')
      : undefined;
```

(`runtimeWorkdir` is already computed above this point in the existing function — reuse it, do not recompute.)

Add `createSkillManageTool(mirroredSkillsDir)` to the `tools:` array passed into `CoreToolExecutor` (currently just `maskedTools`) — change:

```ts
      tools: new CoreToolExecutor({
        tools: maskedTools,
```

to:

```ts
      tools: new CoreToolExecutor({
        tools: mirroredSkillsDir ? [...maskedTools, createSkillManageTool(mirroredSkillsDir)] : maskedTools,
```

Add `workspaceSeedDirs,` to the `AgentRunner` constructor call, alongside the existing `workspaceProvider: sandboxProvider,`.

- [ ] **Step 4: Add `skill_manage` to the card's static tool allowlist**

`agents/outline/agent.config.ts`'s `tools:` array is a confirmed default-deny allowlist —
its own comment says so explicitly: "this list is default-deny: any new tool is excluded
until added here explicitly. Keep in sync with OUTLINE_AGENT_TOOLS in
src/outline-tools.ts." `skill_manage` is built per-request in `compose.ts` (not part of
the static `allTools`/`OUTLINE_AGENT_TOOLS` list), so it must be added to this file's
`tools:` array or the LLM will never see it. Edit `agents/outline/agent.config.ts`,
adding `'skill_manage'` to the `tools` array (after `'excel_create'`):

```ts
  tools: [
    'read',
    'Bash',
    'outline_search',
    'outline_find_documents',
    'outline_eval_search',
    'outline_grep_documents',
    'outline_get_document',
    'outline_list_collections',
    'outline_list_documents',
    'outline_list_revisions',
    'outline_create_document',
    'outline_update_document',
    'outline_restore_document',
    'excel_describe',
    'excel_read',
    'excel_write',
    'excel_format',
    'excel_create',
    'skill_manage',
  ],
```

Also update the adjacent comment's cross-reference (`OUTLINE_AGENT_TOOLS in
src/outline-tools.ts`) if that constant is what `compose.ts`'s `context.tools` filtering
actually checks against — grep `OUTLINE_AGENT_TOOLS` first to confirm whether it needs
the same addition, since `compose.ts`'s `allowed = new Set(context.tools)` filter runs
against `allTools` (built from `buildOutlineTools()`), and `skill_manage` bypasses that
list entirely (it's appended directly in Step 3 above, never filtered by `allowed`) — so
no change to `OUTLINE_AGENT_TOOLS`/`buildOutlineTools()` is needed for `skill_manage`
itself, only the card's `tools:` array (which is what a separate policy/prompt-exposure
check, if any, consults). If `pnpm run build` or a manual run in Step 5/6 shows
`skill_manage` still isn't visible to the LLM after this change, check
`createReactArchitecture`'s own tool-exposure logic in `@dongkseo/architectures` next.

- [ ] **Step 5: Verify types and tests**

Run: `cd /Users/dongkseo99/work/document-agent && pnpm run build` (this repo's `lint`-equivalent is `tsc` via the `build` script — confirm by checking `package.json` scripts; use whichever script actually runs `tsc --noEmit` or `tsc`).
Expected: PASS, 0 type errors.

This repo has no `test` script (confirmed absent from `package.json` `scripts` earlier in this project) — skip a test-run step; instead do a manual smoke check per Step 6.

- [ ] **Step 6: Manual smoke check**

Run: `cd /Users/dongkseo99/work/document-agent && node --env-file=.env dist/src/main.js` is the production entrypoint but requires real Outline credentials; instead exercise the CLI path if one exists without external creds, or note in the PR description that this needs a manual conversation-level check with a real `.pi/skills/` directory present at `PI_SPAWN_CWD/.pi/skills` — confirm `skill_manage({action:"list"})` returns the injected skill and that a `references/<file>` from that skill is readable via the generic `read` tool afterward (this is the actual bug being fixed — verify it end-to-end, not just via type-check).

- [ ] **Step 7: Commit**

```bash
cd /Users/dongkseo99/work/document-agent
git add package.json pnpm-lock.yaml src/skill.tool.ts src/runtime/compose.ts
git commit -m "feat(skills): add skill_manage tool, mirror runtime skills via seedDirs"
```

---

### Task 9: `in7-marketing-poc` — replace hand-rolled mirror with `seedDirs`

**Files:**
- Modify: `/Users/dongkseo99/work/in7-marketing-poc/package.json` (bump `@dongkseo/core`/`@dongkseo/contracts`; also update the `overrides:` block in `pnpm-workspace.yaml` per this repo's own documented convention for pinning nexora versions)
- Delete: `/Users/dongkseo99/work/in7-marketing-poc/src/runtime/skill-workspace-mirror.ts`
- Delete: `/Users/dongkseo99/work/in7-marketing-poc/tests/skill-workspace-mirror.test.ts`
- Modify: `/Users/dongkseo99/work/in7-marketing-poc/src/runtime/build-runtime.ts:291-337` (the `skillDirs = mirrorSkillSourcesForWorkspace(...)` block and its three downstream usages)

**Interfaces:**
- Consumes: `AgentRunnerOptions.workspaceSeedDirs` (Task 5).

- [ ] **Step 1: Bump nexora deps**

Edit `package.json` (`@dongkseo/core`, `@dongkseo/contracts` if listed directly) and `pnpm-workspace.yaml`'s `overrides:` block to the versions from Task 6 — this repo's own convention (documented in project memory and in the file's own comments) requires updating **both** together.

Run: `cd /Users/dongkseo99/work/in7-marketing-poc && pnpm install` and confirm via `git diff pnpm-lock.yaml` that the resolved version actually bumped.

- [ ] **Step 2: Replace the mirror call with a `seedDirs` computation**

In `src/runtime/build-runtime.ts`, remove the import:

```ts
import { mirrorSkillSourcesForWorkspace } from './skill-workspace-mirror.js';
```

Replace the block (currently around line 296-308):

```ts
  const agentSkillsDir = path.join(deps.agentsDir, card.name, 'skills');
  const inheritedSkillsDir = inheritedSkillsOwner
    ? path.join(deps.agentsDir, inheritedSkillsOwner, 'skills')
    : undefined;
  const runtimeSkillsDir = runtimeSkillsDirFromEnvelope(envelope);
  const skillDirs = mirrorSkillSourcesForWorkspace({
    enabled: workspaceEnabled,
    workspaceDir: toolWorkdir,
    agentsDir: deps.agentsDir,
    agentSkillsDir,
    sharedSkillsDir: inheritedSkillsDir,
    runtimeSkillsDir,
  });
```

with:

```ts
  const agentSkillsDir = path.join(deps.agentsDir, card.name, 'skills');
  const inheritedSkillsDir = inheritedSkillsOwner
    ? path.join(deps.agentsDir, inheritedSkillsOwner, 'skills')
    : undefined;
  const runtimeSkillsDir = runtimeSkillsDirFromEnvelope(envelope);
  // owner 세그먼트 — mirrorSkillSourcesForWorkspace가 하던 "agentsDir 기준 상대경로의 첫
  // 세그먼트" 계산을 그대로 유지(카드 이름과 다를 수 있는 상속 케이스 대비).
  const agentSkillsOwner = path.relative(deps.agentsDir, path.dirname(agentSkillsDir)).split(path.sep)[0] || card.name;
  const workspaceSeedDirs = workspaceEnabled
    ? [
        { source: agentSkillsDir, destSubpath: `.skill_refs/agents/${agentSkillsOwner}/skills` },
        ...(inheritedSkillsDir
          ? [{ source: inheritedSkillsDir, destSubpath: `.skill_refs/agents/${inheritedSkillsOwner}/skills` }]
          : []),
        ...(runtimeSkillsDir
          ? [{ source: runtimeSkillsDir, destSubpath: '.skill_refs/runtime/skills' }]
          : []),
      ]
    : undefined;
  const skillDirs = {
    agentSkillsDir: workspaceEnabled ? path.join(toolWorkdir, '.skill_refs', 'agents', agentSkillsOwner, 'skills') : agentSkillsDir,
    sharedSkillsDir: inheritedSkillsDir
      ? (workspaceEnabled ? path.join(toolWorkdir, '.skill_refs', 'agents', inheritedSkillsOwner, 'skills') : inheritedSkillsDir)
      : undefined,
    runtimeSkillsDir: runtimeSkillsDir
      ? (workspaceEnabled ? path.join(toolWorkdir, '.skill_refs', 'runtime', 'skills') : runtimeSkillsDir)
      : undefined,
  };
```

(This keeps every downstream reference to `skillDirs.agentSkillsDir` / `.sharedSkillsDir` / `.runtimeSkillsDir` working unchanged — only the computation moved from "copy now" to "declare where it'll be copied by the time the agent runs.")

Find the `return new AgentRunner({` call in this same function and add `workspaceSeedDirs,` to its options.

- [ ] **Step 3: Delete the old mirror module and its test**

```bash
cd /Users/dongkseo99/work/in7-marketing-poc
git rm src/runtime/skill-workspace-mirror.ts tests/skill-workspace-mirror.test.ts
```

- [ ] **Step 4: Verify types and tests**

Run: `cd /Users/dongkseo99/work/in7-marketing-poc && pnpm lint`
Expected: PASS, 0 type errors (no remaining references to the deleted module — grep to confirm: `grep -r "skill-workspace-mirror" src/ tests/` should return nothing).

Run: `cd /Users/dongkseo99/work/in7-marketing-poc && pnpm test`
Expected: PASS. Any test that previously exercised `mirrorSkillSourcesForWorkspace`'s copy behavior directly is now covered by nexora's own `workspace-seed.test.ts` (Task 1) — do not re-add an equivalent test here; if `build-runtime.test.ts` (or similar) asserted on the old function's call shape, update it to assert on the new `workspaceSeedDirs` array shape instead.

- [ ] **Step 5: Commit**

```bash
cd /Users/dongkseo99/work/in7-marketing-poc
git add -A
git commit -m "refactor(skills): replace hand-rolled workspace mirror with core seedDirs"
```

---

## Self-Review Notes

- **Spec coverage**: Task 1-2 cover the contracts/core mechanism; Task 3-5 cover both `WorkspaceProvider` implementations plus the harness threading (fresh acquire, resume, and per-runtime forwarding) — all three code paths the spec's "명시 결정" (re-seed on every acquire, including resume) requires. Task 6 covers the release gate. Tasks 7-9 cover all three named consumers in the spec's rollout order.
- **No placeholders**: every step has literal code, exact file paths, and exact commands. The two steps that can't have a fully pre-written command (Task 6 Step 4's publish gate, Task 8 Step 6's manual smoke check) are explicit stop-and-verify instructions, not vague "add error handling"-style gaps — they name exactly what to confirm and why a scripted command can't be handed over safely (unpublished credentials/process for the former, real Outline creds + a live `.pi/skills` dir for the latter).
- **Type consistency**: `WorkspaceSeedEntry`/`seedDirs` uses the exact same `{ source, destSubpath }` shape end-to-end — `workspace.ts` (Task 2) → `workspace-seed.ts` (Task 1) → every call site in Tasks 3-5 and 7-9.
