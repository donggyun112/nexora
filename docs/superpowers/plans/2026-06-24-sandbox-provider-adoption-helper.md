# createSandboxProvider — 공유 도입 헬퍼 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ixpert·in7 두 소비 프로젝트가 공통으로 import할 **`createSandboxProvider(opts)`**(레이어① OS 격리 정책 + 레이어② 대화-단위 고정-root를 묶은 팩토리)와 **샌드박스 빌트인 도구 묶음**(`sandboxToolDefinitions`/`registerSandboxTools`)을 nexora 재사용 export로 신설한다.

**Architecture:** `createSandboxProvider`는 기존 `AsrtSandboxClient`(이미 `WorkspaceProvider`+`SandboxClient` 구현)를 **개방-but-비밀안전 정책**(읽기는 넓게, 비밀 경로만 차단) + **영속 기본값**(perRun:false, cleanup:'keep')으로 구성해 반환하는 얇은 팩토리다. AsrtSandboxClient 단독 기본값은 홈 전체 읽기 차단이라 스펙의 "개방" 철학(§1, §2.4)과 어긋나는데, 이 헬퍼가 정본 정책을 한 곳에 박아 drift를 막는다. 도구 묶음은 `@dongkseo/tools`의 `create{Read,Write,Edit,Grep,Exec}Tool`을 한 번에 조립한다.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, `@anthropic-ai/sandbox-runtime`(테스트에서 모킹), pnpm workspace (`@dongkseo/core`, `@dongkseo/tools`).

상위 설계: `docs/superpowers/specs/2026-06-24-runtime-isolation-adoption-design.md` §3-레이어① + §3-레이어② + §4.3 + §4.6(헬퍼 위치 = nexora 재사용 export, 결정됨).

## Global Constraints

- **헬퍼 위치 (결정됨)**: `createSandboxProvider` + 정책 상수는 `@dongkseo/core`(`AsrtSandboxClient`와 같은 패키지)에 신설·export. 도구 묶음은 `@dongkseo/tools`(create*Tool과 같은 패키지)에 신설·export. 각자 자연스러운 패키지.
- **개방-but-비밀안전 정책 (정본)**: 읽기는 넓게 열되 비밀 경로만 차단한다. `denyRead` 기본 = 큐레이트된 비밀 경로 목록(`SANDBOX_SECRET_DENYLIST`). 소비자 `denyRead`는 이 목록에 **병합**(추가)되며 비밀 차단을 무력화할 수 없다(`[...SANDBOX_SECRET_DENYLIST, ...opts.denyRead]`).
- **네트워크 기본 차단**: `allowedDomains` 기본 `[]` → 전면 차단(`strictAllowlist:true`는 AsrtSandboxClient가 이미 설정). 소비자가 allowlist 제공.
- **영속 기본값**: `perRun:false`, `cleanup:'keep'`, `mode:'workspace-write'`. perRun:false면 acquire 시 harness가 넘기는 `baseWorkdir`(= `ToolContext.workdir`, 대화별 `<base>/<conversationId>`)가 root가 된다. `root` 옵션을 주면 그 고정 경로가 baseWorkdir보다 우선.
- **반환 타입**: `createSandboxProvider`는 `AsrtSandboxClient`를 반환(WorkspaceProvider+SandboxClient라 consumer가 resume/snapshot도 사용 가능).
- **테스트**: core는 `@anthropic-ai/sandbox-runtime`이 미설치라 `tsc` 빌드 불가 → 기존 asrt 테스트처럼 **SDK를 모킹**해 vitest로 검증(`pnpm --filter @dongkseo/core test`). tools는 `pnpm --filter @dongkseo/tools test`.
- **exec 도구 정책**: 도구 묶음의 exec 옵션은 **순수 passthrough**(`ExecToolOptions`). 스펙 §3은 "exec 전체 허용(OS 샌드박스가 경계)"을 의도하지만 `createExecTool`의 `allowList` 기본은 빈 배열=전체 거부다. 이 묶음은 allow-all을 **강제하지 않고** 소비자가 `exec.allowList`를 명시하게 둔다(ixpert/in7 플랜에서 결정). 묶음은 도구 집합 조립만 책임진다.
- **커밋**: AI 서명/Co-Authored-By 금지 (전역 규칙).

---

### Task 1: createSandboxProvider + 비밀 denylist (`@dongkseo/core`)

**Files:**
- Create: `packages/core/src/sandbox-provider.ts`
- Modify: `packages/core/src/index.ts:78-82` (export 추가)
- Test: `packages/core/src/__tests__/sandbox-provider.test.ts`

**Interfaces:**
- Consumes: `AsrtSandboxClient`, `AsrtSandboxClientOptions` (from `./asrt-sandbox-client.js`), `SnapshotBackend` (from `@dongkseo/contracts`), `node:os`, `node:path`.
- Produces:
  - `SANDBOX_SECRET_DENYLIST: string[]` — 절대경로 비밀 목록(홈 기준).
  - `SandboxProviderOptions { allowedDomains?: string[]; denyRead?: string[]; allowRead?: string[]; perRun?: boolean; baseDir?: string; root?: string; cleanup?: 'keep'|'delete'; snapshotBackend?: SnapshotBackend }`
  - `createSandboxProvider(options?: SandboxProviderOptions): AsrtSandboxClient`

- [ ] **Step 1: Write the failing test**

`packages/core/src/__tests__/sandbox-provider.test.ts` 생성. (asrt 테스트와 동일하게 SDK를 모킹 — `wrapWithSandboxArgv`에 넘어가는 config로 정책을 검증.)

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

describe('createSandboxProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies the open-but-secret-safe policy to the run config', async () => {
    const { createSandboxProvider, SANDBOX_SECRET_DENYLIST } = await import('../sandbox-provider.js');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-sbp-pol-'));
    try {
      const provider = createSandboxProvider({ allowedDomains: ['registry.npmjs.org'] });
      const session = await provider.acquire({ baseWorkdir: base });
      await session.run?.({ argv: ['echo', 'hi'] });

      const cfg = sandboxManager.wrapWithSandboxArgv.mock.calls[0]![2] as {
        filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[] };
        network: { allowedDomains: string[] };
      };
      // 비밀 경로는 전부 차단되고, 읽기는 root 포함 넓게 열린다.
      for (const secret of SANDBOX_SECRET_DENYLIST) {
        expect(cfg.filesystem.denyRead).toContain(secret);
      }
      expect(cfg.filesystem.allowRead).toContain(session.root);
      expect(cfg.filesystem.allowWrite).toContain(session.root);
      // 네트워크는 소비자 allowlist만 허용.
      expect(cfg.network.allowedDomains).toEqual(['registry.npmjs.org']);
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  it('merges consumer denyRead onto the secret denylist (cannot un-deny secrets)', async () => {
    const { createSandboxProvider, SANDBOX_SECRET_DENYLIST } = await import('../sandbox-provider.js');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-sbp-merge-'));
    try {
      const provider = createSandboxProvider({ denyRead: ['/custom/secret'] });
      const session = await provider.acquire({ baseWorkdir: base });
      await session.run?.({ argv: ['echo', 'hi'] });
      const cfg = sandboxManager.wrapWithSandboxArgv.mock.calls[0]![2] as {
        filesystem: { denyRead: string[] };
      };
      expect(cfg.filesystem.denyRead).toContain('/custom/secret');
      expect(cfg.filesystem.denyRead).toContain(SANDBOX_SECRET_DENYLIST[0]);
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  it('defaults to network-blocked (empty allowlist)', async () => {
    const { createSandboxProvider } = await import('../sandbox-provider.js');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-sbp-net-'));
    try {
      const provider = createSandboxProvider();
      const session = await provider.acquire({ baseWorkdir: base });
      await session.run?.({ argv: ['echo', 'hi'] });
      const cfg = sandboxManager.wrapWithSandboxArgv.mock.calls[0]![2] as {
        network: { allowedDomains: string[] };
      };
      expect(cfg.network.allowedDomains).toEqual([]);
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  it('persists across runs by default (perRun false, same baseWorkdir reuses root)', async () => {
    const { createSandboxProvider } = await import('../sandbox-provider.js');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-sbp-persist-'));
    try {
      const provider = createSandboxProvider();
      const a = await provider.acquire({ baseWorkdir: base });
      await fsp.writeFile(path.join(a.root, 'memo.txt'), 'keep');
      await a.cleanup(); // cleanup:'keep' → root 보존

      const b = await provider.acquire({ baseWorkdir: base });
      expect(b.root).toBe(a.root);
      expect(await fsp.readFile(path.join(b.root, 'memo.txt'), 'utf8')).toBe('keep');
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dongkseo/core test -- sandbox-provider`
Expected: FAIL — `Cannot find module '../sandbox-provider.js'`.

- [ ] **Step 3: Implement createSandboxProvider**

`packages/core/src/sandbox-provider.ts` 생성:

```typescript
/**
 * createSandboxProvider — 소비 프로젝트(ixpert·in7) 공용 도입 팩토리.
 *
 * 레이어① OS 격리 정책(개방-but-비밀안전: 읽기는 넓게, 비밀 경로만 차단, 네트워크
 * 기본 차단) + 레이어② 대화-단위 고정-root(perRun:false, cleanup:'keep')를 묶어
 * AsrtSandboxClient를 구성한다. 정책 정본을 한 곳에 둬 소비자 간 drift를 막는다.
 *
 * 상위 설계: docs/superpowers/specs/2026-06-24-runtime-isolation-adoption-design.md §3-④, §4.3
 */

import os from 'node:os';
import path from 'node:path';
import type { SnapshotBackend } from '@dongkseo/contracts';
import { AsrtSandboxClient } from './asrt-sandbox-client.js';

/**
 * 항상 읽기 차단되는 비밀 경로(홈 기준 절대경로). 소비자 denyRead는 여기에 병합되며
 * 이 목록을 무력화할 수 없다. "개방" 철학상 그 외 읽기는 넓게 허용한다.
 */
export const SANDBOX_SECRET_DENYLIST: string[] = [
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.aws'),
  path.join(os.homedir(), '.config', 'gcloud'),
  path.join(os.homedir(), '.config', 'gh'),
  path.join(os.homedir(), '.gnupg'),
  path.join(os.homedir(), '.kube'),
  path.join(os.homedir(), '.docker', 'config.json'),
  path.join(os.homedir(), '.netrc'),
  path.join(os.homedir(), '.npmrc'),
  path.join(os.homedir(), 'Library', 'Keychains'),
];

export interface SandboxProviderOptions {
  /** 에이전트가 접근 가능한 네트워크 도메인. 기본 [] → 전면 차단. */
  allowedDomains?: string[];
  /** 추가 읽기-차단 경로. 비밀 denylist에 병합되며 비밀 차단을 무력화할 수 없다. */
  denyRead?: string[];
  /** 워크스페이스 root 외에 읽기 허용할 경로. */
  allowRead?: string[];
  /** 매 run마다 새 tmp root(true) vs 대화 root 재사용(false). 기본 false. */
  perRun?: boolean;
  /** perRun:true일 때 tmp root들이 생기는 베이스 디렉토리. */
  baseDir?: string;
  /** 고정 root 오버라이드(대화별 baseWorkdir보다 우선). */
  root?: string;
  /** 정리 모드. 기본 'keep'(대화 영속). */
  cleanup?: 'keep' | 'delete';
  /** 영속 스냅샷 백엔드. 기본 inline-root(NoopSnapshotBackend). */
  snapshotBackend?: SnapshotBackend;
}

/** 개방-but-비밀안전 정책 + 대화-단위 영속으로 구성한 WorkspaceProvider. */
export function createSandboxProvider(options: SandboxProviderOptions = {}): AsrtSandboxClient {
  return new AsrtSandboxClient({
    mode: 'workspace-write',
    perRun: options.perRun ?? false,
    cleanup: options.cleanup ?? 'keep',
    baseDir: options.baseDir,
    root: options.root,
    allowedDomains: options.allowedDomains ?? [],
    denyRead: [...SANDBOX_SECRET_DENYLIST, ...(options.denyRead ?? [])],
    allowRead: options.allowRead ?? [],
    snapshotBackend: options.snapshotBackend,
  });
}
```

`packages/core/src/index.ts`(L78-82 인근, AsrtSandboxClient export 다음)에 추가:

```typescript
export { createSandboxProvider, SANDBOX_SECRET_DENYLIST } from './sandbox-provider.js';
export type { SandboxProviderOptions } from './sandbox-provider.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dongkseo/core test -- sandbox-provider`
Expected: 4개 PASS. 회귀 확인 → `pnpm --filter @dongkseo/core test` 전체 그린(기존 176 + 4).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sandbox-provider.ts packages/core/src/index.ts \
  packages/core/src/__tests__/sandbox-provider.test.ts
git commit -m "feat(core): createSandboxProvider — 개방-but-비밀안전 정책 + 대화 영속 도입 팩토리"
```

---

### Task 2: 샌드박스 빌트인 도구 묶음 (`@dongkseo/tools`)

**Files:**
- Create: `packages/tools/src/builtin/sandbox-bundle.ts`
- Modify: `packages/tools/src/builtin/index.ts:5-11` (export 추가)
- Test: `packages/tools/src/__tests__/sandbox-bundle.test.ts` (없으면 생성; 디렉토리 위치는 기존 tools 테스트 관례 따름)

**Interfaces:**
- Consumes: `createReadTool`, `createWriteTool`, `createEditTool`, `createGrepTool`, `createExecTool`, `ExecToolOptions` (from `./read.js` 등 또는 `./index.js`), `ToolDefinition` (from `@dongkseo/contracts`), `ToolRegistry` (from `../registry.js`).
- Produces:
  - `SandboxToolBundleOptions { exec?: ExecToolOptions }`
  - `sandboxToolDefinitions(options?: SandboxToolBundleOptions): ToolDefinition[]` — `[read, write, edit, grep, exec]` 반환.
  - `registerSandboxTools(registry: ToolRegistry, options?: SandboxToolBundleOptions): void` — 위 묶음을 registry에 등록.

- [ ] **Step 1: Write the failing test**

먼저 tools 테스트 디렉토리 관례 확인: `ls packages/tools/src/__tests__/` (없으면 `packages/tools/src/` 하위 `*.test.ts` 위치 확인 후 동일 위치에 둔다).

`packages/tools/src/__tests__/sandbox-bundle.test.ts` 생성:

```typescript
import { describe, expect, it } from 'vitest';
import { sandboxToolDefinitions, registerSandboxTools } from '../builtin/sandbox-bundle.js';
import { ToolRegistry } from '../registry.js';

describe('sandboxToolDefinitions', () => {
  it('returns the five sandbox-aware builtin tools', () => {
    const names = sandboxToolDefinitions().map(t => t.name).sort();
    expect(names).toEqual(['edit', 'exec', 'grep', 'read', 'write']);
  });

  it('forwards exec options without throwing', () => {
    const defs = sandboxToolDefinitions({ exec: { allowList: ['python3'], defaultTimeoutMs: 60_000 } });
    expect(defs.find(t => t.name === 'exec')).toBeDefined();
  });
});

describe('registerSandboxTools', () => {
  it('registers all five tools into a registry', () => {
    const registry = new ToolRegistry();
    registerSandboxTools(registry);
    const assembled = registry.assemble({}).map(t => t.name).sort();
    for (const name of ['edit', 'exec', 'grep', 'read', 'write']) {
      expect(assembled).toContain(name);
    }
  });
});
```

(주의: `ToolRegistry` import 경로와 `assemble({})` 시그니처는 `packages/tools/src/registry.ts`의 실제 export로 확인 후 맞춘다. `assemble`이 availability 게이트로 일부를 거른다면, 대신 `registry.register` 호출 횟수를 spy하거나 registry가 노출하는 조회 API로 검증한다 — 5개가 등록됐음을 확인하는 게 목적.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dongkseo/tools test -- sandbox-bundle`
Expected: FAIL — `Cannot find module '../builtin/sandbox-bundle.js'`.

- [ ] **Step 3: Implement the bundle**

`packages/tools/src/builtin/sandbox-bundle.ts` 생성:

```typescript
/**
 * 샌드박스 빌트인 도구 묶음 — createSandboxProvider로 워크스페이스를 격리한
 * 소비 프로젝트가 한 번에 등록하는 파일/프로세스 도구 세트.
 *
 * read/write/edit/grep는 ctx.workspace.resolve()/run()을 통해 워크스페이스 경계
 * 안에서 동작하고, exec는 ctx.workspace.run()으로 샌드박스 안에서 임의 명령을
 * 실행한다. exec의 allowList 등 하드닝은 소비자가 options.exec로 정한다.
 */

import type { ToolDefinition } from '@dongkseo/contracts';
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createGrepTool,
  createExecTool,
  type ExecToolOptions,
} from './index.js';
import type { ToolRegistry } from '../registry.js';

export interface SandboxToolBundleOptions {
  /** exec 도구 하드닝(allowList/allowShell/timeout). 미지정 시 createExecTool 기본값. */
  exec?: ExecToolOptions;
}

/** read/write/edit/grep/exec 도구 정의 묶음을 만든다. */
export function sandboxToolDefinitions(
  options: SandboxToolBundleOptions = {},
): ToolDefinition[] {
  return [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createGrepTool(),
    createExecTool(options.exec ?? {}),
  ];
}

/** 묶음을 ToolRegistry에 등록한다. */
export function registerSandboxTools(
  registry: ToolRegistry,
  options: SandboxToolBundleOptions = {},
): void {
  registry.registerAll(sandboxToolDefinitions(options));
}
```

`packages/tools/src/builtin/index.ts`(L5-11 인근, create*Tool export 다음)에 추가:

```typescript
export { sandboxToolDefinitions, registerSandboxTools } from './sandbox-bundle.js';
export type { SandboxToolBundleOptions } from './sandbox-bundle.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dongkseo/tools test -- sandbox-bundle`
Expected: 3개 PASS. 회귀 확인 → `pnpm --filter @dongkseo/tools test` 전체 그린.

- [ ] **Step 5: Type-check (선택적 교차 빌드)**

Run: `pnpm --filter @dongkseo/tools build`
Expected: tsc 클린.

- [ ] **Step 6: Commit**

```bash
git add packages/tools/src/builtin/sandbox-bundle.ts packages/tools/src/builtin/index.ts \
  packages/tools/src/__tests__/sandbox-bundle.test.ts
git commit -m "feat(tools): 샌드박스 빌트인 도구 묶음 (sandboxToolDefinitions / registerSandboxTools)"
```

---

## Self-Review

**1. Spec coverage:** 이 플랜은 스펙 §4.3의 두 산출물을 구현한다 — `createSandboxProvider(opts)`(레이어① 정책 + 레이어② 고정-root, Task 1)와 빌트인 도구 등록 묶음(Task 2). §4.6의 헬퍼 위치 결정(nexora 재사용 export)을 반영해 core/tools에 둔다. 정책 내용은 §3-레이어①(mode workspace-write, denyRead 비밀, allowedDomains 최소, network 기본 차단)과 §2.4(읽기 기본 넓음)를 "개방-but-비밀안전"으로 구현. **범위 밖(의도)**: 실제 ixpert/in7 배선(§4.4-4.5), ArtifactChannel 빌트인 도구 `share_artifact`/`get_artifact`(§4.2 선택)는 각각 후속 플랜. exec "전체 허용"의 최종 판정은 소비자 플랜에서(이 묶음은 passthrough).

**2. Placeholder scan:** TBD/TODO 없음. 모든 코드 스텝에 실제 코드 포함. Task 2 Step 1의 `ToolRegistry.assemble({})` 검증은 실제 시그니처 확인 후 맞추라는 구체 지시 + 대안(spy/조회 API) 제시 — placeholder 아님(검증 목적 명시). core가 `tsc` 불가한 건 SDK 미설치 때문이며 테스트는 SDK 모킹으로 돈다(레포 확립 패턴).

**3. Type consistency:** `SandboxProviderOptions`/`createSandboxProvider`/`SANDBOX_SECRET_DENYLIST`(Task 1)와 `SandboxToolBundleOptions`/`sandboxToolDefinitions`/`registerSandboxTools`(Task 2) 명칭이 본문·테스트·export에서 일치. `createSandboxProvider`는 `AsrtSandboxClient` 반환(WorkspaceProvider+SandboxClient) — harness의 `workspaceProvider?: WorkspaceProvider`에 직접 주입 가능. `denyRead` 병합은 `[...SANDBOX_SECRET_DENYLIST, ...opts.denyRead]`로 Task 1 본문·테스트 동일. exec 옵션 타입은 `@dongkseo/tools`의 `ExecToolOptions` 재사용.
