# Runtime Isolation — nexora Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `AsrtSandboxClient`에 대화-단위 영속을 위한 고정-root 모드를 추가하고(`HostWorkspaceProvider.perRun`과 대칭), 전역 `SandboxManager` 동시성 거동을 특성화하여 in7 적용 게이트를 판정한다.

**Architecture:** `AsrtSandboxClient.create()`가 현재 무조건 `mkdtemp`(런 단위 휘발)하는 것을, `perRun:false` + `root`/`baseWorkdir` 시 고정 디렉토리를 재사용하도록 분기. `cleanup`은 고정-root에선 기본 `keep`. 동시성은 `wrapWithSandboxArgv`(per-command config)와 `updateConfig`(전역) 경로를 특성화 테스트로 문서화.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, `@anthropic-ai/sandbox-runtime@^0.0.59`, pnpm workspace (`@dongkseo/core`).

상위 설계: `docs/superpowers/specs/2026-06-24-runtime-isolation-adoption-design.md`

## Global Constraints

- **플랫폼**: macOS 전용 (seatbelt). 테스트는 `@anthropic-ai/sandbox-runtime`을 모킹하므로 OS 무관하게 통과해야 함.
- **하위 호환**: `perRun` 기본값 `true` — 기존 호출자(옵션 미지정)는 종전과 동일하게 `mkdtemp`/`delete` 거동 유지.
- **대칭성**: 옵션·필드·헬퍼 명명은 `HostWorkspaceProvider`(`packages/core/src/workspace-provider.ts`)를 그대로 미러링 (`root?`, `perRun?`, `createRunRoot`, `resolveExistingRoot`).
- **테스트 러너**: `pnpm --filter @dongkseo/core test` (vitest). 기존 5개 asrt 테스트 회귀 없어야 함.
- **커밋**: AI 서명/Co-Authored-By 금지 (전역 규칙).

---

### Task 1: AsrtSandboxClient 고정-root 모드 (`perRun` / `root`)

**Files:**
- Modify: `packages/core/src/asrt-sandbox-client.ts:38-126` (options/fields/constructor/create + 헬퍼 추가)
- Test: `packages/core/src/__tests__/asrt-sandbox-client.test.ts` (추가)

**Interfaces:**
- Consumes: `WorkspaceAcquireOptions { baseWorkdir?, runId?, input?, metadata? }` (from `@dongkseo/contracts`), `safeWorkspaceSegment` (from `./workspace-path.js`, 기존 import).
- Produces:
  - `AsrtSandboxClientOptions` 에 `root?: string` + `perRun?: boolean` 추가.
  - `AsrtSandboxClient.create(options?: WorkspaceAcquireOptions): Promise<WorkspaceSession>` — `perRun:false`면 `root ?? options.baseWorkdir`를 재사용, 아니면 기존 `mkdtemp`.

- [ ] **Step 1: Write the failing test (고정 root 재사용)**

`packages/core/src/__tests__/asrt-sandbox-client.test.ts` 의 `describe` 블록 안에 추가:

```typescript
it('reuses a fixed root across runs when perRun is false', async () => {
  const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
  const fixedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-fixed-'));
  try {
    const client = new AsrtSandboxClient({ perRun: false, root: fixedRoot, cleanup: 'keep' });

    const a = await client.create({ runId: 'turn-1' });
    const b = await client.create({ runId: 'turn-2' });

    expect(a.root).toBe(await fsp.realpath(fixedRoot));
    expect(b.root).toBe(a.root);
  } finally {
    await fsp.rm(fixedRoot, { recursive: true, force: true });
  }
});

it('persists files across sessions on a fixed root with cleanup keep', async () => {
  const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
  const fixedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-persist-'));
  try {
    const client = new AsrtSandboxClient({ perRun: false, root: fixedRoot, cleanup: 'keep' });

    const first = await client.create({ runId: 'turn-1' });
    await fsp.writeFile(path.join(first.root, 'draft.txt'), 'hello');
    await first.cleanup();

    const second = await client.create({ runId: 'turn-2' });
    const body = await fsp.readFile(path.join(second.root, 'draft.txt'), 'utf8');
    expect(body).toBe('hello');
  } finally {
    await fsp.rm(fixedRoot, { recursive: true, force: true });
  }
});

it('uses baseWorkdir as the fixed root when no explicit root is set', async () => {
  const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-asrt-base-'));
  try {
    const client = new AsrtSandboxClient({ perRun: false, cleanup: 'keep' });
    const session = await client.create({ baseWorkdir: base });
    expect(session.root).toBe(await fsp.realpath(base));
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

it('throws when perRun is false and neither root nor baseWorkdir is provided', async () => {
  const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
  const client = new AsrtSandboxClient({ perRun: false });
  await expect(client.create({})).rejects.toThrow(/root, baseWorkdir, or perRun/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dongkseo/core test -- asrt-sandbox-client`
Expected: 새 4개 FAIL (현재 `create()`가 항상 `mkdtemp` → `reuses a fixed root` 등 실패; `perRun`/`root` 옵션 미존재).

- [ ] **Step 3: Add options + fields**

`packages/core/src/asrt-sandbox-client.ts` `AsrtSandboxClientOptions`(L38-57)에 추가:

```typescript
  /** When false, reuse a fixed root across runs instead of mkdtemp per run. Default true. */
  perRun?: boolean;
  /** Fixed workspace root used when perRun is false (falls back to acquire baseWorkdir). */
  root?: string;
```

클래스 필드(L62-79 영역)에 추가:

```typescript
  private readonly perRun: boolean;
  private readonly root?: string;
```

- [ ] **Step 4: Wire constructor (mirror HostWorkspaceProvider)**

constructor(L81-100) 내에서 `this.cleanupMode` 라인을 교체하고 두 필드를 설정:

```typescript
    this.perRun = options.perRun ?? true;
    this.root = options.root;
    this.cleanupMode = options.cleanup ?? (this.perRun ? 'delete' : 'keep');
```

(기존 `this.cleanupMode = options.cleanup ?? 'delete';` 한 줄을 위 3줄로 대체.)

- [ ] **Step 5: Branch create() + add helpers**

`create()`(L106-126)의 첫 두 줄을 분기로 교체:

```typescript
  async create(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    const id = options.runId ?? crypto.randomUUID();
    const root = this.perRun
      ? await this.createRunRoot(id)
      : await this.resolveExistingRoot(options.baseWorkdir);
    const config = this.buildConfig(root);
    await ensureSandboxManagerInitialized(config);
    // …기존 return new AsrtSandboxSession({ … }) 그대로…
```

`delete()`(L128-130) 아래(클래스 내, `buildConfig` 위)에 헬퍼 추가:

```typescript
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @dongkseo/core test -- asrt-sandbox-client`
Expected: 새 4개 PASS + 기존 5개 PASS (회귀 없음). 특히 기존 `creates a per-run workspace…`(옵션 미지정 → `perRun` 기본 true → 여전히 `mkdtemp` + `delete`)가 통과해야 함.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/asrt-sandbox-client.ts packages/core/src/__tests__/asrt-sandbox-client.test.ts
git commit -m "feat(core): AsrtSandboxClient 고정-root 모드 (perRun/root, 대화-단위 영속)"
```

---

### Task 2: 동시성 특성화 — 전역 SandboxManager 거동 (in7 게이트)

**Files:**
- Create: `packages/core/src/__tests__/asrt-sandbox-concurrency.test.ts`
- Modify: `docs/superpowers/specs/2026-06-24-runtime-isolation-adoption-design.md` (§5.1에 검증 결과 1문단 기록)

**Interfaces:**
- Consumes: Task 1의 `AsrtSandboxClient({ perRun:false, root })`, 모킹된 `SandboxManager` (`wrapWithSandboxArgv`, `updateConfig`, `isSandboxingEnabled`).
- Produces: 게이트 판정(문서). 코드 API 산출물 없음.

목적: "동시 대화(서로 다른 root)가 전역 `SandboxManager`를 통해 서로의 정책을 오염시키는가"를 코드로 특성화한다. 핵심 사실(조사 완료): `run()`은 **세션별 config를 `wrapWithSandboxArgv(cmd, cwd, config, signal)`로 per-command 전달**(FS 정책은 명령 단위로 격리됨)하지만, `ensureSandboxManagerInitialized`는 이미 enabled면 **`updateConfig(config)`로 전역 config를 교체**(`asrt-sandbox-client.ts:254-256`)한다. 네트워크 프록시는 `initialize` 시점 전역.

- [ ] **Step 1: Write the characterization test (전역 updateConfig 교체 입증)**

`packages/core/src/__tests__/asrt-sandbox-concurrency.test.ts` 생성:

```typescript
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sandboxManager = vi.hoisted(() => ({
  isSupportedPlatform: vi.fn(() => true),
  isSandboxingEnabled: vi.fn(() => false),
  initialize: vi.fn(async () => {}),
  updateConfig: vi.fn(() => {}),
  wrapWithSandboxArgv: vi.fn(async () => ({
    argv: [process.execPath, '-e', 'process.stdout.write("ok")'],
    env: process.env,
  })),
  cleanupAfterCommand: vi.fn(() => {}),
}));

vi.mock('@anthropic-ai/sandbox-runtime', () => ({ SandboxManager: sandboxManager }));

describe('AsrtSandboxClient concurrency characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('per-command run() carries each session own filesystem config (isolated per command)', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const rootA = await fsp.mkdtemp(path.join(os.tmpdir(), 'asrt-concA-'));
    const rootB = await fsp.mkdtemp(path.join(os.tmpdir(), 'asrt-concB-'));
    try {
      const client = new AsrtSandboxClient({ perRun: false, cleanup: 'keep' });
      const a = await client.create({ baseWorkdir: rootA });
      const b = await client.create({ baseWorkdir: rootB });

      await a.run?.({ argv: ['echo', 'a'] });
      await b.run?.({ argv: ['echo', 'b'] });

      const calls = sandboxManager.wrapWithSandboxArgv.mock.calls;
      const cfgA = calls[0][2];
      const cfgB = calls[1][2];
      // FS 정책은 명령마다 그 세션 root를 담아 전달된다 → per-command 격리됨.
      expect(cfgA.filesystem.allowWrite).toContain(a.root);
      expect(cfgB.filesystem.allowWrite).toContain(b.root);
      expect(cfgA.filesystem.allowWrite).not.toContain(b.root);
    } finally {
      await fsp.rm(rootA, { recursive: true, force: true });
      await fsp.rm(rootB, { recursive: true, force: true });
    }
  });

  it('global init path replaces config on second acquire when sandboxing already enabled', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const rootA = await fsp.mkdtemp(path.join(os.tmpdir(), 'asrt-gA-'));
    const rootB = await fsp.mkdtemp(path.join(os.tmpdir(), 'asrt-gB-'));
    try {
      const client = new AsrtSandboxClient({ perRun: false, cleanup: 'keep' });
      sandboxManager.isSandboxingEnabled.mockReturnValue(true); // 이미 활성 가정
      await client.create({ baseWorkdir: rootA });
      await client.create({ baseWorkdir: rootB });

      // 두 번째 acquire는 updateConfig로 전역 config를 B 기준으로 교체한다(전역 상태 공유 입증).
      expect(sandboxManager.updateConfig).toHaveBeenCalledTimes(2);
      const lastCfg = sandboxManager.updateConfig.mock.calls.at(-1)?.[0];
      expect(lastCfg.filesystem.allowWrite).toContain(await fsp.realpath(rootB));
    } finally {
      sandboxManager.isSandboxingEnabled.mockReturnValue(false);
      await fsp.rm(rootA, { recursive: true, force: true });
      await fsp.rm(rootB, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @dongkseo/core test -- asrt-sandbox-concurrency`
Expected: 2개 PASS. (의미: FS 정책은 per-command 격리 OK / 전역 init·프록시·updateConfig 경로는 공유됨.)

- [ ] **Step 3: 실제 런타임 의미 확인 (소스 독해, 코드 변경 없음)**

`node_modules/.pnpm/@anthropic-ai+sandbox-runtime@0.0.59/.../sandbox/` 에서 `wrapWithSandboxArgv`가 전달받은 `config`로 매 명령의 seatbelt 프로파일을 생성하는지(FS per-command 격리 성립) vs `initialize` 전역 상태(네트워크 프록시 포트/도메인 allowlist)에 의존하는지 확인. 확인 포인트:
- FS allow/deny: `wrapWithSandboxArgv(config)`로 명령 단위 적용 → **동시 다른 root 안전**으로 기대.
- 네트워크: 프록시는 전역 1회 `initialize`. 동시 대화가 **동일 도메인 allowlist 공유** → in7에서 대화별 다른 네트워크 정책이 필요하면 제약.

- [ ] **Step 4: 게이트 판정 기록**

스펙 `§5.1`에 결과 1문단 추가 (예시, 실제 확인값으로):

```markdown
**동시성 검증 결과(2026-06-24)**: FS 정책은 `wrapWithSandboxArgv`로 per-command 전달되어
동시 다른-root 세션 간 파일 격리는 성립. 단 네트워크 프록시/도메인 allowlist는 `initialize`
전역 1회 → 동시 대화가 동일 네트워크 정책을 공유. in7은 (a) 모든 대화에 공통 도메인 allowlist를
쓰거나 (b) exec 네트워크를 끄는 선에서 안전. 대화별 상이 네트워크 정책은 현재 비지원 →
필요 시 별도 과제.
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/__tests__/asrt-sandbox-concurrency.test.ts docs/superpowers/specs/2026-06-24-runtime-isolation-adoption-design.md
git commit -m "test(core): asrt 동시성 특성화 + in7 게이트 판정 기록"
```

---

## Self-Review

**1. Spec coverage:** 이 플랜은 스펙 §3-레이어② + §4.1(고정-root 모드) + §5.1(동시성 게이트)를 구현한다. 스펙의 ArtifactChannel(§4.2), 공유 도입 패턴(§4.3), in7/ixpert 배선(§4.4-4.5)은 **후속 플랜**(Plan 2/3/4)으로 분리됨 — 의도된 범위 분할.

**2. Placeholder scan:** TBD/TODO 없음. Step 3(소스 독해)는 "확인 포인트"를 구체 명시, Step 4는 기록 문단 예시 제공. 모든 코드 스텝에 실제 코드 포함.

**3. Type consistency:** `perRun?: boolean` / `root?: string` 옵션·필드·`createRunRoot`/`resolveExistingRoot` 헬퍼명이 `HostWorkspaceProvider`와 동일. `create(options?: WorkspaceAcquireOptions)` 시그니처는 기존과 동일(분기만 추가). 테스트의 `wrapWithSandboxArgv` 모킹 시그니처는 기존 테스트와 일치.
