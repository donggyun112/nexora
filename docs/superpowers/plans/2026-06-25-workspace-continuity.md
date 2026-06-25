# 워크스페이스 연속성 (snapshot 오케스트레이션 + conversation 바인딩) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 멀티턴 대화에서 에이전트 워크스페이스(파일시스템 상태)가 턴 경계를 넘어 연속되도록 — 턴 종료 시 snapshot을 떠서 conversationId-키 store에 묶고, 다음 턴 시작에 복원하는 데코레이터 provider를 만든다.

**Architecture:** 데코레이터 패턴. `ContinuousWorkspaceProvider`가 `WorkspaceProvider`(하네스가 보는 인터페이스)를 구현하되 inner로 `AsrtSandboxClient`(resume 보유)를 감싼다. `acquire()`는 `WorkspaceStateStore`에서 직전 snapshot을 로드해 `resume()`(없으면 `acquire()`), 반환 세션의 `cleanup()`을 snapshot+persist로 래핑한다. hot/cold는 `resume()` 내부에서 fingerprint 비교로 자동 결정(live 고정 root가 마지막 snapshot 이후 안 변했으면 restore 스킵). 하네스/bootstrap은 변경 없음 — 데코레이터인지 raw provider인지 모른다.

**Tech Stack:** TypeScript (ESM, `.js` import 확장자), Node `node:crypto`/`node:fs/promises`, vitest, monorepo 패키지 `@dongkseo/contracts`·`@dongkseo/core`·`@dongkseo/store`·`@dongkseo/store-json`·`@dongkseo/store-pg`.

## Global Constraints

- **선행 설계**: `docs/superpowers/specs/2026-06-25-workspace-continuity-design.md` 섹션 6의 데코레이터 안이 채택안. 본 플랜은 그 §6.2–6.4를 구현한다.
- **비목표**: prod 와이어링(소비 프로젝트 담당), 증분/CoW snapshot, cross-host 마이그레이션, transcript 변경, history/rollback(대화당 최신 snapshot 1개만 유지).
- **ESM import**: 모든 상대 import는 `.js` 확장자 사용 (예: `./workspace-snapshot.js`).
- **테스트 러너**: vitest. 각 패키지에서 `pnpm --filter <pkg> test` 또는 루트 `pnpm test`.
- **No Claude/AI attribution** in commit messages (사용자 전역 규칙).
- **기존 회귀 금지**: `workspaceProvider` 미주입 경로(데코레이터 미사용)는 기존과 100% 동일해야 한다. `AsrtSandboxClient.resume()`의 기존 시그니처/동작은 fingerprint-match가 아닐 때 그대로 유지(= 항상 restore).
- **store 키 컨벤션**: `conversationId`를 파일명/PK로 직접 사용 (기존 `SuspendedTurnStoreJson`/`Pg`의 `pendingId` 패턴과 동일).

---

## File Structure

신규 파일:
| 파일 | 책임 |
|---|---|
| `packages/contracts/src/workspace-state.ts` | `WorkspaceStateStore` 계약 (load/save/delete, conversationId 키) |
| `packages/core/src/continuous-workspace-provider.ts` | 데코레이터 — resume-or-acquire + snapshot-on-cleanup |
| `packages/store-json/src/workspace-state.ts` | `WorkspaceStateStoreJson` (파일 백엔드) |
| `packages/store-pg/src/workspace-state.ts` | `WorkspaceStateStorePg` (Postgres 백엔드) |
| `packages/core/src/__tests__/continuous-workspace-provider.test.ts` | 데코레이터 단위/e2e 테스트 |
| `packages/store-json/src/__tests__/workspace-state.test.ts` | json 라운드트립 테스트 |

변경 파일:
- `packages/contracts/src/workspace.ts` — `WorkspaceSnapshot`에 `fingerprint?: string`
- `packages/contracts/src/index.ts` — `WorkspaceStateStore` export
- `packages/core/src/workspace-snapshot.ts` — `fingerprintRoot(dir)` SHA256 헬퍼
- `packages/core/src/asrt-sandbox-client.ts` — `snapshot()`에 fingerprint 계산, `resume()`에 hot/cold 분기
- `packages/core/src/index.ts` — `ContinuousWorkspaceProvider`, `fingerprintRoot` export
- `packages/store-json/src/index.ts` — `WorkspaceStateStoreJson` export + `JsonStoreProvider` 필드
- `packages/store-pg/src/index.ts` — `WorkspaceStateStorePg` export + `PgStoreProvider` 필드
- `packages/store-pg/src/pg-client.ts` — `nexora_workspace_state` 테이블 마이그레이션
- `packages/store/src/factory.ts` — `StoreProvider.workspaceState?` + `warnDevStores`
- `packages/store/src/index.ts` — `WorkspaceStateStore` re-export
- `packages/core/src/__tests__/asrt-sandbox-client.test.ts` — fingerprint hot/cold 테스트 추가
- `packages/core/src/__tests__/workspace-snapshot.test.ts` — `fingerprintRoot` 테스트 추가

---

## Task A: fingerprint 계산 + hot/cold resume 분기

스냅샷 엔진에 fingerprint 인지를 추가한다. `snapshot()`은 root의 SHA256을 기록하고, `resume()`은 고정 root가 살아있고 fingerprint가 일치하면 비싼 restore를 스킵한다(hot path).

**Files:**
- Modify: `packages/contracts/src/workspace.ts:36-49` (`WorkspaceSnapshot`)
- Modify: `packages/core/src/workspace-snapshot.ts` (add `fingerprintRoot`)
- Modify: `packages/core/src/asrt-sandbox-client.ts:133-142` (`resume`), `:280-296` (`snapshot`)
- Modify: `packages/core/src/index.ts:86` (export `fingerprintRoot`)
- Test: `packages/core/src/__tests__/workspace-snapshot.test.ts`, `packages/core/src/__tests__/asrt-sandbox-client.test.ts`

**Interfaces:**
- Produces: `fingerprintRoot(dir: string): Promise<string>` (in `@dongkseo/core`, re-from `workspace-snapshot.js`)
- Produces: `WorkspaceSnapshot.fingerprint?: string` (in `@dongkseo/contracts`)
- Consumes: 기존 `SnapshotBackend`(persist/restore/restorable), `WorkspaceSnapshot{id,backend,ref,root,createdAt,metadata}`

- [ ] **Step 1: `WorkspaceSnapshot`에 fingerprint 필드 추가**

`packages/contracts/src/workspace.ts`의 `WorkspaceSnapshot` 인터페이스 (현재 L36-49) — `createdAt?: string;` 다음 줄에 추가:

```ts
  createdAt?: string;
  /**
   * SHA256 of the root's contents at snapshot time. On resume, a live fixed
   * root whose fingerprint still matches lets us skip the restore (hot path);
   * a mismatch (or a fresh per-run root) forces a tar restore (cold path).
   */
  fingerprint?: string;
  metadata?: Record<string, unknown>;
```

- [ ] **Step 2: `fingerprintRoot` 실패 테스트 작성**

`packages/core/src/__tests__/workspace-snapshot.test.ts` — `import` 줄에 `fingerprintRoot` 추가하고 파일 끝에 describe 블록 추가:

```ts
// (상단 import 수정)
import {
  LocalTarSnapshotBackend,
  NoopSnapshotBackend,
  fingerprintRoot,
} from '../workspace-snapshot.js';

// (파일 끝에 추가)
describe('fingerprintRoot', () => {
  it('is stable for identical content and changes when a file changes', async () => {
    const dir = await mkTmp('nexora-fp-');
    await fsp.mkdir(path.join(dir, 'nested'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.txt'), 'one');
    await fsp.writeFile(path.join(dir, 'nested', 'b.txt'), 'two');

    const first = await fingerprintRoot(dir);
    const again = await fingerprintRoot(dir);
    expect(again).toBe(first);

    await fsp.writeFile(path.join(dir, 'nested', 'b.txt'), 'changed');
    const after = await fingerprintRoot(dir);
    expect(after).not.toBe(first);
  });

  it('changes when a file is added', async () => {
    const dir = await mkTmp('nexora-fp-');
    await fsp.writeFile(path.join(dir, 'a.txt'), 'one');
    const before = await fingerprintRoot(dir);
    await fsp.writeFile(path.join(dir, 'c.txt'), 'three');
    expect(await fingerprintRoot(dir)).not.toBe(before);
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm --filter @dongkseo/core test workspace-snapshot`
Expected: FAIL — `fingerprintRoot is not a function` / import 에러.

- [ ] **Step 4: `fingerprintRoot` 구현**

`packages/core/src/workspace-snapshot.ts` — 기존 import는 `crypto` 기본 import가 이미 있다(`import crypto from 'node:crypto';`). 파일 끝(마지막 `runTar` 함수 뒤)에 추가:

```ts
/**
 * Deterministic SHA256 fingerprint of a directory tree's contents. Walks every
 * regular file (sorted by relative path) and folds each path + bytes into one
 * digest, so the result changes iff any file is added, removed, or modified.
 * Drives the hot path on resume (live root unchanged → skip restore).
 *
 * v1 is a full-content hash with no exclusions; see design 9.2 for lighter
 * alternatives (mtime+size, exclude patterns) once workspaces grow large.
 */
export async function fingerprintRoot(dir: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const files = await collectFilesRelative(dir, dir);
  files.sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await fsp.readFile(path.join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function collectFilesRelative(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out; // missing dir → empty fingerprint contribution
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFilesRelative(root, abs)));
    } else if (entry.isFile()) {
      out.push(path.relative(root, abs));
    }
  }
  return out;
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm --filter @dongkseo/core test workspace-snapshot`
Expected: PASS (기존 + 신규 fingerprint 테스트 모두).

- [ ] **Step 6: hot/cold resume 실패 테스트 작성**

`packages/core/src/__tests__/asrt-sandbox-client.test.ts` 파일 끝(마지막 `});` 뒤, 최상위)에 추가. 이 파일은 상단에서 `@anthropic-ai/sandbox-runtime`를 mock하고 `AsrtSandboxClient`를 동적 import 한다(기존 패턴 그대로 사용):

```ts
describe('AsrtSandboxClient.resume fingerprint hot/cold', () => {
  function makeBackend() {
    return {
      kind: 'test-tar',
      persist: vi.fn(async () => 'ref-1'),
      restore: vi.fn(async () => {}),
      restorable: vi.fn(async () => true),
    };
  }

  it('skips restore when the fixed root is unchanged (HOT)', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-hot-'));
    try {
      const backend = makeBackend();
      const client = new AsrtSandboxClient({ perRun: false, root, snapshotBackend: backend });
      const session = await client.create();
      await fsp.writeFile(path.join(root, 'file.txt'), 'v1');
      const snap = await session.snapshot();
      expect(snap.fingerprint).toBeTruthy();

      await client.resume(snap); // root untouched since snapshot
      expect(backend.restore).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('restores when the fixed root changed since snapshot (COLD)', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-cold-'));
    try {
      const backend = makeBackend();
      const client = new AsrtSandboxClient({ perRun: false, root, snapshotBackend: backend });
      const session = await client.create();
      await fsp.writeFile(path.join(root, 'file.txt'), 'v1');
      const snap = await session.snapshot();

      await fsp.writeFile(path.join(root, 'file.txt'), 'v2-mutated');
      await client.resume(snap);
      expect(backend.restore).toHaveBeenCalledTimes(1);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('always restores for a fresh per-run root (COLD)', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-perrun-'));
    try {
      const backend = makeBackend();
      const client = new AsrtSandboxClient({ perRun: true, baseDir, snapshotBackend: backend });
      const session = await client.create();
      await fsp.writeFile(path.join(session.root, 'file.txt'), 'v1');
      const snap = await session.snapshot();

      await client.resume(snap); // fresh mkdtemp → live fingerprint undefined
      expect(backend.restore).toHaveBeenCalledTimes(1);
    } finally {
      await fsp.rm(baseDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 7: 테스트 실패 확인**

Run: `pnpm --filter @dongkseo/core test asrt-sandbox-client`
Expected: FAIL — HOT 케이스에서 `restore`가 호출됨(현재 resume은 ref 있으면 무조건 restore), `snap.fingerprint`가 undefined.

- [ ] **Step 8: `snapshot()`에 fingerprint, `resume()`에 hot/cold 분기 구현**

`packages/core/src/asrt-sandbox-client.ts` — 먼저 import에 `fingerprintRoot` 추가 (현재 L33):

```ts
import { NoopSnapshotBackend, fingerprintRoot } from './workspace-snapshot.js';
```

`resume()` (현재 L133-142) 교체:

```ts
  async resume(state: WorkspaceSnapshot): Promise<WorkspaceSession> {
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
    return this.buildSession(id, root);
  }
```

`AsrtSandboxSession.snapshot()` (현재 L280-296) 교체:

```ts
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
```

- [ ] **Step 9: `fingerprintRoot` core export 추가**

`packages/core/src/index.ts:86` — 기존:

```ts
export { LocalTarSnapshotBackend, NoopSnapshotBackend } from './workspace-snapshot.js';
```

교체:

```ts
export { LocalTarSnapshotBackend, NoopSnapshotBackend, fingerprintRoot } from './workspace-snapshot.js';
```

- [ ] **Step 10: 테스트 통과 + 타입체크 확인**

Run: `pnpm --filter @dongkseo/contracts build && pnpm --filter @dongkseo/core test asrt-sandbox-client workspace-snapshot`
Expected: PASS (hot/cold 3 케이스 + fingerprint 테스트 모두), 타입 에러 없음.

- [ ] **Step 11: 커밋**

```bash
git add packages/contracts/src/workspace.ts packages/core/src/workspace-snapshot.ts packages/core/src/asrt-sandbox-client.ts packages/core/src/index.ts packages/core/src/__tests__/workspace-snapshot.test.ts packages/core/src/__tests__/asrt-sandbox-client.test.ts
git commit -m "feat(core): fingerprint-driven hot/cold resume for workspace snapshots"
```

---

## Task B: `WorkspaceStateStore` 계약

conversationId로 키된 영속 store 인터페이스 — snapshot ref를 대화에 묶는다(separate-but-linked). 대화당 최신 1개만(덮어쓰기).

**Files:**
- Create: `packages/contracts/src/workspace-state.ts`
- Modify: `packages/contracts/src/index.ts:160` 부근 (workspace export 블록 뒤)

**Interfaces:**
- Produces: `WorkspaceStateStore { load(conversationId): Promise<WorkspaceSnapshot|null>; save(conversationId, snapshot): Promise<void>; delete(conversationId): Promise<void> }`
- Consumes: `WorkspaceSnapshot` (Task A에서 fingerprint 추가됨)

- [ ] **Step 1: 계약 파일 작성**

Create `packages/contracts/src/workspace-state.ts`:

```ts
/**
 * Workspace-state persistence contract.
 *
 * Binds a conversation to its latest workspace snapshot so the next turn of the
 * same conversation can recover its filesystem. This is *separate-but-linked*:
 * a different store from the transcript (system of record), keyed by the same
 * `conversationId`. Only the most recent snapshot per conversation is kept
 * (save overwrites); history/rollback is a non-goal.
 *
 * Implementations live outside @dongkseo/contracts (file-based in
 * @dongkseo/store-json, Postgres in @dongkseo/store-pg). The orchestrator that
 * reads/writes it is `ContinuousWorkspaceProvider` in @dongkseo/core.
 */

import type { WorkspaceSnapshot } from './workspace.js';

export interface WorkspaceStateStore {
  /** Latest snapshot for a conversation, or null if none persisted yet. */
  load(conversationId: string): Promise<WorkspaceSnapshot | null>;
  /** Persist (insert or overwrite) the latest snapshot for a conversation. */
  save(conversationId: string, snapshot: WorkspaceSnapshot): Promise<void>;
  /** Drop a conversation's snapshot record (e.g. on conversation end). */
  delete(conversationId: string): Promise<void>;
}
```

- [ ] **Step 2: contracts index export 추가**

`packages/contracts/src/index.ts` — workspace export 블록(`} from './workspace.js';`, 현재 L161) 바로 뒤에 추가:

```ts
export type { WorkspaceStateStore } from './workspace-state.js';
```

- [ ] **Step 3: 빌드로 검증**

Run: `pnpm --filter @dongkseo/contracts build`
Expected: PASS — 타입 에러 없음, `WorkspaceStateStore` export 가능.

- [ ] **Step 4: 커밋**

```bash
git add packages/contracts/src/workspace-state.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): WorkspaceStateStore contract (conversationId-keyed snapshot binding)"
```

---

## Task C: `WorkspaceStateStoreJson` + json provider 와이어링

파일 백엔드 — `{dataDir}/workspace-state/{conversationId}.json` 한 대화 = 한 파일 (덮어쓰기). `SuspendedTurnStoreJson` 패턴과 병렬.

**Files:**
- Create: `packages/store-json/src/workspace-state.ts`
- Modify: `packages/store-json/src/index.ts`
- Test: `packages/store-json/src/__tests__/workspace-state.test.ts`

**Interfaces:**
- Consumes: `WorkspaceStateStore`, `WorkspaceSnapshot`, `StoreBackendInfo`, `DescribableStore` (from `@dongkseo/contracts`)
- Produces: `WorkspaceStateStoreJson` class; `JsonStoreProvider.workspaceState: WorkspaceStateStoreJson`

- [ ] **Step 1: 라운드트립 실패 테스트 작성**

Create `packages/store-json/src/__tests__/workspace-state.test.ts`:

```ts
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '@dongkseo/contracts';
import { WorkspaceStateStoreJson } from '../workspace-state.js';

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-wsstate-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

const snap = (id: string): WorkspaceSnapshot => ({
  id,
  backend: 'local-tar',
  ref: `/snaps/${id}.tar`,
  root: `/work/${id}`,
  fingerprint: `fp-${id}`,
});

describe('WorkspaceStateStoreJson', () => {
  it('round-trips save/load by conversationId', async () => {
    const store = new WorkspaceStateStoreJson(await mkTmp());
    await store.save('conv-1', snap('s1'));
    expect(await store.load('conv-1')).toEqual(snap('s1'));
  });

  it('returns null for an unknown conversation', async () => {
    const store = new WorkspaceStateStoreJson(await mkTmp());
    expect(await store.load('missing')).toBeNull();
  });

  it('overwrites — keeps only the latest snapshot', async () => {
    const store = new WorkspaceStateStoreJson(await mkTmp());
    await store.save('conv-1', snap('old'));
    await store.save('conv-1', snap('new'));
    expect((await store.load('conv-1'))?.id).toBe('new');
  });

  it('delete removes the record', async () => {
    const store = new WorkspaceStateStoreJson(await mkTmp());
    await store.save('conv-1', snap('s1'));
    await store.delete('conv-1');
    expect(await store.load('conv-1')).toBeNull();
  });

  it('describes a dev backend', () => {
    const store = new WorkspaceStateStoreJson('/tmp/x');
    expect(store.describeBackend().type).toBe('dev');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @dongkseo/store-json test workspace-state`
Expected: FAIL — `WorkspaceStateStoreJson` 모듈 없음.

- [ ] **Step 3: 구현 작성**

Create `packages/store-json/src/workspace-state.ts`:

```ts
/**
 * WorkspaceStateStoreJson — JSON 파일.
 *
 * 파일 구조: {dataDir}/workspace-state/{conversationId}.json (한 대화 = 한 파일, 덮어쓰기)
 * 참고: suspended-turn.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  WorkspaceStateStore,
  WorkspaceSnapshot,
  StoreBackendInfo,
  DescribableStore,
} from '@dongkseo/contracts';

export class WorkspaceStateStoreJson implements WorkspaceStateStore, DescribableStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'workspace-state');
  }

  describeBackend(): StoreBackendInfo {
    return { name: 'json-file', type: 'dev', durable: true, multiProcess: false };
  }

  private filePath(conversationId: string): string {
    return path.join(this.dir, `${conversationId}.json`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  async save(conversationId: string, snapshot: WorkspaceSnapshot): Promise<void> {
    this.ensureDir();
    fs.writeFileSync(this.filePath(conversationId), JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  async load(conversationId: string): Promise<WorkspaceSnapshot | null> {
    const file = this.filePath(conversationId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as WorkspaceSnapshot;
    } catch {
      return null;
    }
  }

  async delete(conversationId: string): Promise<void> {
    const file = this.filePath(conversationId);
    if (fs.existsSync(file)) fs.rmSync(file);
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @dongkseo/store-json test workspace-state`
Expected: PASS (5 케이스).

- [ ] **Step 5: json provider에 와이어링**

`packages/store-json/src/index.ts` 수정 — 세 곳:

1. export 블록(`export { ArtifactChannelJson } from './artifact.js';` 뒤)에 추가:

```ts
export { WorkspaceStateStoreJson } from './workspace-state.js';
```

2. import 블록(`import { ArtifactChannelJson } from './artifact.js';` 뒤)에 추가:

```ts
import { WorkspaceStateStoreJson } from './workspace-state.js';
```

3. `JsonStoreProvider` 인터페이스의 `artifact: ArtifactChannelJson;` 뒤에 추가:

```ts
  workspaceState: WorkspaceStateStoreJson;
```

4. `createJsonStoreProvider`의 `artifact: new ArtifactChannelJson(dataDir),` 뒤에 추가:

```ts
    workspaceState: new WorkspaceStateStoreJson(dataDir),
```

(선택) 상단 섹션 맵 주석에 `//   Workspace state ./workspace-state   WorkspaceStateStoreJson   (대화별 워크스페이스 snapshot 바인딩)` 한 줄 추가.

- [ ] **Step 6: 패키지 테스트 통과 확인**

Run: `pnpm --filter @dongkseo/store-json test`
Expected: PASS — 신규 + 기존 모두 그린.

- [ ] **Step 7: 커밋**

```bash
git add packages/store-json/src/workspace-state.ts packages/store-json/src/index.ts packages/store-json/src/__tests__/workspace-state.test.ts
git commit -m "feat(store-json): WorkspaceStateStoreJson + provider wiring"
```

---

## Task D: `WorkspaceStateStorePg` + 마이그레이션 + pg provider 와이어링

Postgres 백엔드. `SuspendedTurnStorePg`(JSONB upsert by PK) 패턴과 병렬. pg는 라이브 DB 없이 단위 테스트가 어려우므로(기존 store-pg는 빌드/타입으로 검증) 타입체크 + 빌드로 게이트.

**Files:**
- Create: `packages/store-pg/src/workspace-state.ts`
- Modify: `packages/store-pg/src/pg-client.ts` (migrate에 테이블 추가)
- Modify: `packages/store-pg/src/index.ts`

**Interfaces:**
- Consumes: `WorkspaceStateStore`, `WorkspaceSnapshot`, `StoreBackendInfo`, `DescribableStore` (contracts); `Sql` (`./pg-client.js`), `jsonParam` (`./helpers.js`)
- Produces: `WorkspaceStateStorePg` class; `PgStoreProvider.workspaceState: WorkspaceStateStorePg`

- [ ] **Step 1: 마이그레이션 테이블 추가**

`packages/store-pg/src/pg-client.ts` — `migrate()` 함수 안, 마지막 테이블(`nexora_artifacts` 인덱스들, 현재 ~L218) 뒤·함수 닫는 `}` 앞에 추가:

```ts
  await sql`
    CREATE TABLE IF NOT EXISTS nexora_workspace_state (
      conversation_id TEXT PRIMARY KEY,
      data            JSONB NOT NULL
    )
  `;
```

- [ ] **Step 2: pg store 구현 작성**

Create `packages/store-pg/src/workspace-state.ts`:

```ts
/**
 * WorkspaceStateStorePg — PostgreSQL-backed workspace-state store.
 * 참고: suspended-turn.ts (JSONB upsert by primary key).
 */

import type {
  WorkspaceStateStore,
  WorkspaceSnapshot,
  StoreBackendInfo,
  DescribableStore,
} from '@dongkseo/contracts';
import type { Sql } from './pg-client.js';
import { jsonParam } from './helpers.js';

export class WorkspaceStateStorePg implements WorkspaceStateStore, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async save(conversationId: string, snapshot: WorkspaceSnapshot): Promise<void> {
    await this.sql`
      INSERT INTO nexora_workspace_state (conversation_id, data)
      VALUES (${conversationId}, ${jsonParam(this.sql, snapshot)})
      ON CONFLICT (conversation_id) DO UPDATE SET data = ${jsonParam(this.sql, snapshot)}
    `;
  }

  async load(conversationId: string): Promise<WorkspaceSnapshot | null> {
    const rows = await this.sql`
      SELECT data FROM nexora_workspace_state WHERE conversation_id = ${conversationId}
    `;
    return rows.length > 0 ? (rows[0].data as WorkspaceSnapshot) : null;
  }

  async delete(conversationId: string): Promise<void> {
    await this.sql`
      DELETE FROM nexora_workspace_state WHERE conversation_id = ${conversationId}
    `;
  }
}
```

- [ ] **Step 3: pg provider에 와이어링**

`packages/store-pg/src/index.ts` 수정 — 네 곳:

1. export 블록(`export { ArtifactChannelPg } from './artifact.js';` 뒤)에 추가:

```ts
export { WorkspaceStateStorePg } from './workspace-state.js';
```

2. import 블록(`import { ArtifactChannelPg } from './artifact.js';` 뒤)에 추가:

```ts
import { WorkspaceStateStorePg } from './workspace-state.js';
```

3. `PgStoreProvider` 인터페이스의 `artifact: ArtifactChannelPg;` 뒤에 추가:

```ts
  workspaceState: WorkspaceStateStorePg;
```

4. `createPgStoreProvider`의 `artifact: new ArtifactChannelPg(sql),` 뒤에 추가:

```ts
    workspaceState: new WorkspaceStateStorePg(sql),
```

(선택) 상단 섹션 맵 주석에 `//   Workspace state ./workspace-state   WorkspaceStateStorePg            (대화별 워크스페이스 snapshot 바인딩)` 한 줄 추가.

- [ ] **Step 4: 빌드 + 타입체크 통과 확인**

Run: `pnpm --filter @dongkseo/store-pg build && pnpm --filter @dongkseo/store-pg test`
Expected: PASS — 타입 에러 없음. (라이브 DB 없는 테스트는 기존대로 스킵/그린.)

- [ ] **Step 5: 커밋**

```bash
git add packages/store-pg/src/workspace-state.ts packages/store-pg/src/pg-client.ts packages/store-pg/src/index.ts
git commit -m "feat(store-pg): WorkspaceStateStorePg + migration + provider wiring"
```

---

## Task E: `StoreProvider.workspaceState` + `@dongkseo/store` re-export

union 계약 `StoreProvider`에 optional `workspaceState`를 추가(transcript와 동일하게 optional — store-memory 등 미구현 백엔드 비파괴)하고 `warnDevStores`에 포함. contracts 타입 re-export.

**Files:**
- Modify: `packages/store/src/factory.ts`
- Modify: `packages/store/src/index.ts`

**Interfaces:**
- Consumes: `WorkspaceStateStore` (contracts)
- Produces: `StoreProvider.workspaceState?: WorkspaceStateStore`; `@dongkseo/store` re-exports `WorkspaceStateStore`

- [ ] **Step 1: `StoreProvider`에 필드 + import 추가**

`packages/store/src/factory.ts` — import 블록의 `ArtifactChannel,` 뒤에 추가:

```ts
  WorkspaceStateStore,
```

`StoreProvider` 인터페이스의 `transcript?: TranscriptStore;` 뒤에 추가:

```ts
  /** 대화별 워크스페이스 snapshot 바인딩 (conversationId 키). Optional until all backends implement it. */
  workspaceState?: WorkspaceStateStore;
```

- [ ] **Step 2: `warnDevStores`에 포함**

`packages/store/src/factory.ts` — `warnDevStores`의 `stores` 배열에서 `['artifact', provider.artifact],` 뒤에 추가:

```ts
    ['workspaceState', provider.workspaceState],
```

(`isDescribable`가 undefined를 안전 처리하므로 미주입 백엔드에서도 무해.)

- [ ] **Step 3: `@dongkseo/store` 타입 re-export**

`packages/store/src/index.ts` — `export type { ... } from '@dongkseo/contracts';` 블록의 `ArtifactPublishOptions,` 뒤에 추가:

```ts
  WorkspaceStateStore,
```

- [ ] **Step 4: 빌드 통과 확인**

Run: `pnpm --filter @dongkseo/store build`
Expected: PASS — 타입 에러 없음.

- [ ] **Step 5: 커밋**

```bash
git add packages/store/src/factory.ts packages/store/src/index.ts
git commit -m "feat(store): surface WorkspaceStateStore through StoreProvider"
```

---

## Task F: `ContinuousWorkspaceProvider` 데코레이터 + e2e

resume-or-acquire + snapshot-on-cleanup 데코레이터. 하네스가 보는 `WorkspaceProvider`를 구현, inner로 resume 보유 클라이언트를 감싼다. best-effort: snapshot/load 실패가 턴을 죽이지 않는다.

**Files:**
- Create: `packages/core/src/continuous-workspace-provider.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/continuous-workspace-provider.test.ts`

**Interfaces:**
- Consumes: `WorkspaceProvider`, `WorkspaceSession`, `WorkspaceAcquireOptions`, `WorkspaceSnapshot`, `WorkspaceStateStore` (contracts); 실제 동작은 `AsrtSandboxClient`(Task A의 resume) 또는 동형 fake.
- Produces: `class ContinuousWorkspaceProvider implements WorkspaceProvider`; `ResumableWorkspaceProvider` 타입; ctor `(inner, store, conversationId, options?)`.

- [ ] **Step 1: 데코레이터 실패 테스트 작성**

Create `packages/core/src/__tests__/continuous-workspace-provider.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceSession,
  WorkspaceSnapshot,
  WorkspaceStateStore,
} from '@dongkseo/contracts';
import { ContinuousWorkspaceProvider } from '../continuous-workspace-provider.js';

function makeStore(initial: WorkspaceSnapshot | null = null): WorkspaceStateStore & {
  saved: WorkspaceSnapshot[];
} {
  let current = initial;
  const saved: WorkspaceSnapshot[] = [];
  return {
    saved,
    async load() {
      return current;
    },
    async save(_id, snap) {
      current = snap;
      saved.push(snap);
    },
    async delete() {
      current = null;
    },
  };
}

function makeSession(id: string, snap?: WorkspaceSnapshot): WorkspaceSession & {
  cleaned: boolean;
} {
  const session = {
    id,
    root: `/work/${id}`,
    mode: 'workspace-write' as const,
    mounts: [],
    cleaned: false,
    async resolve() {
      throw new Error('not used');
    },
    async snapshot() {
      return snap ?? ({ id, backend: 'inline-root', root: `/work/${id}` } as WorkspaceSnapshot);
    },
    async cleanup() {
      session.cleaned = true;
    },
  };
  return session;
}

describe('ContinuousWorkspaceProvider', () => {
  it('acquires fresh when no prior snapshot exists', async () => {
    const store = makeStore(null);
    const inner = {
      acquire: vi.fn(async () => makeSession('fresh')),
      resume: vi.fn(async () => makeSession('resumed')),
    };
    const provider = new ContinuousWorkspaceProvider(inner, store, 'conv-1');

    const session = await provider.acquire();
    expect(inner.acquire).toHaveBeenCalledTimes(1);
    expect(inner.resume).not.toHaveBeenCalled();
    expect(session.id).toBe('fresh');
  });

  it('resumes from the prior snapshot on a later turn', async () => {
    const prior: WorkspaceSnapshot = { id: 's1', backend: 'local-tar', ref: 'r1', root: '/work/s1' };
    const store = makeStore(prior);
    const inner = {
      acquire: vi.fn(async () => makeSession('fresh')),
      resume: vi.fn(async () => makeSession('resumed')),
    };
    const provider = new ContinuousWorkspaceProvider(inner, store, 'conv-1');

    await provider.acquire();
    expect(inner.resume).toHaveBeenCalledWith(prior);
    expect(inner.acquire).not.toHaveBeenCalled();
  });

  it('snapshots and persists on cleanup', async () => {
    const store = makeStore(null);
    const snap: WorkspaceSnapshot = { id: 'snap-1', backend: 'local-tar', ref: 'r', root: '/work' };
    const inner = {
      acquire: vi.fn(async () => makeSession('fresh', snap)),
      resume: vi.fn(async () => makeSession('resumed')),
    };
    const provider = new ContinuousWorkspaceProvider(inner, store, 'conv-1');

    const session = await provider.acquire();
    await session.cleanup();
    expect(store.saved).toEqual([snap]);
  });

  it('does not throw from cleanup when snapshot fails (best-effort)', async () => {
    const store = makeStore(null);
    const session = makeSession('fresh');
    session.snapshot = vi.fn(async () => {
      throw new Error('disk full');
    });
    const inner = {
      acquire: vi.fn(async () => session),
      resume: vi.fn(async () => makeSession('resumed')),
    };
    const provider = new ContinuousWorkspaceProvider(inner, store, 'conv-1');

    const wrapped = await provider.acquire();
    await expect(wrapped.cleanup()).resolves.toBeUndefined();
    expect(store.saved).toEqual([]);
    expect((session as unknown as { cleaned: boolean }).cleaned).toBe(true);
  });

  it('falls back to fresh acquire when resume throws (corrupt state)', async () => {
    const prior: WorkspaceSnapshot = { id: 's1', backend: 'local-tar', ref: 'bad', root: '/gone' };
    const store = makeStore(prior);
    const inner = {
      acquire: vi.fn(async () => makeSession('fresh')),
      resume: vi.fn(async () => {
        throw new Error('cannot restore');
      }),
    };
    const provider = new ContinuousWorkspaceProvider(inner, store, 'conv-1');

    const session = await provider.acquire();
    expect(inner.resume).toHaveBeenCalledTimes(1);
    expect(inner.acquire).toHaveBeenCalledTimes(1);
    expect(session.id).toBe('fresh');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @dongkseo/core test continuous-workspace-provider`
Expected: FAIL — `ContinuousWorkspaceProvider` 모듈 없음.

- [ ] **Step 3: 데코레이터 구현 작성**

Create `packages/core/src/continuous-workspace-provider.ts`:

```ts
/**
 * ContinuousWorkspaceProvider — turn 경계를 넘어 워크스페이스를 연속시키는 데코레이터.
 *
 * 하네스가 보는 `WorkspaceProvider`를 구현하되, inner로 resume을 보유한 sandbox
 * 클라이언트(예: AsrtSandboxClient)를 감싼다. `acquire()`는 conversationId로
 * 직전 snapshot을 로드해 `resume()`(없거나 실패하면 `acquire()`)하고, 반환 세션의
 * `cleanup()`을 snapshot+persist로 래핑한다. 하네스/bootstrap은 데코레이터인지
 * raw provider인지 모른다(완전 투명).
 *
 * best-effort: snapshot persist/load 실패는 로그 후 swallow — 가용성 > 무결성
 * (설계 §7). 같은 conversationId의 턴은 직렬화된다고 가정(설계 §7 동시성).
 *
 * 설계: docs/superpowers/specs/2026-06-25-workspace-continuity-design.md §6
 */

import type {
  WorkspaceProvider,
  WorkspaceSession,
  WorkspaceAcquireOptions,
  WorkspaceSnapshot,
  WorkspaceStateStore,
} from '@dongkseo/contracts';

/** inner는 fresh acquire + snapshot resume 둘 다 할 수 있어야 한다. */
export interface ResumableWorkspaceProvider extends WorkspaceProvider {
  resume(state: WorkspaceSnapshot): Promise<WorkspaceSession>;
}

export interface ContinuousWorkspaceProviderOptions {
  /** Optional sink for best-effort failure logs. */
  onWarn?: (message: string, error: unknown) => void;
}

export class ContinuousWorkspaceProvider implements WorkspaceProvider {
  constructor(
    private readonly inner: ResumableWorkspaceProvider,
    private readonly store: WorkspaceStateStore,
    private readonly conversationId: string,
    private readonly options: ContinuousWorkspaceProviderOptions = {},
  ) {}

  async acquire(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    let prior: WorkspaceSnapshot | null = null;
    try {
      prior = await this.store.load(this.conversationId);
    } catch (err) {
      this.warn('workspace-state load failed; acquiring fresh', err);
      prior = null;
    }

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
    return this.wrapCleanup(session);
  }

  private wrapCleanup(session: WorkspaceSession): WorkspaceSession {
    const origCleanup = session.cleanup.bind(session);
    const snapshotFn = session.snapshot?.bind(session);
    const store = this.store;
    const conversationId = this.conversationId;
    const warn = this.warn.bind(this);

    session.cleanup = async (): Promise<void> => {
      try {
        if (snapshotFn) {
          const snap = await snapshotFn();
          if (snap) await store.save(conversationId, snap);
        }
      } catch (err) {
        warn('workspace snapshot/persist failed on cleanup', err);
      }
      await origCleanup();
    };
    return session;
  }

  private warn(message: string, error: unknown): void {
    this.options.onWarn?.(message, error);
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @dongkseo/core test continuous-workspace-provider`
Expected: PASS (6 케이스).

- [ ] **Step 5: core index export 추가**

`packages/core/src/index.ts` — `export { AsrtSandboxClient } ...` 인접 export 영역(L82-86 부근)에 추가:

```ts
export { ContinuousWorkspaceProvider } from './continuous-workspace-provider.js';
export type {
  ResumableWorkspaceProvider,
  ContinuousWorkspaceProviderOptions,
} from './continuous-workspace-provider.js';
```

- [ ] **Step 6: end-to-end 연속성 테스트 작성 (실제 AsrtSandboxClient + tar 백엔드)**

`packages/core/src/__tests__/continuous-workspace-provider.test.ts` 파일 끝에 추가. 상단 import에 추가:

```ts
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
```

`@anthropic-ai/sandbox-runtime` mock은 이 파일에서 필요하다 — 파일 최상단(import 뒤)에 추가:

```ts
const sandboxManager = vi.hoisted(() => ({
  isSupportedPlatform: vi.fn(() => true),
  isSandboxingEnabled: vi.fn(() => false),
  initialize: vi.fn(async () => {}),
  updateConfig: vi.fn(() => {}),
  wrapWithSandboxArgv: vi.fn(async () => ({ argv: ['true'], env: process.env })),
  cleanupAfterCommand: vi.fn(() => {}),
}));
vi.mock('@anthropic-ai/sandbox-runtime', () => ({ SandboxManager: sandboxManager }));
```

그리고 e2e describe 블록 추가:

```ts
describe('ContinuousWorkspaceProvider end-to-end (real client + tar)', () => {
  it('carries a file from turn 1 into turn 2 after the original root is gone (cold path)', async () => {
    const { AsrtSandboxClient } = await import('../asrt-sandbox-client.js');
    const { LocalTarSnapshotBackend } = await import('../workspace-snapshot.js');
    const { WorkspaceStateStoreJson } = await import('@dongkseo/store-json');

    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-cont-data-'));
    const snapDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-cont-snaps-'));
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-cont-base-'));
    try {
      const store = new WorkspaceStateStoreJson(dataDir);
      const backend = new LocalTarSnapshotBackend(snapDir);
      // perRun:true → 각 턴이 fresh root → snapshot/restore 경로(cold)를 강제.
      const client = new AsrtSandboxClient({ perRun: true, baseDir, snapshotBackend: backend });

      // 턴 1
      const p1 = new ContinuousWorkspaceProvider(client, store, 'conv-e2e');
      const s1 = await p1.acquire();
      await fsp.writeFile(path.join(s1.root, 'note.txt'), 'turn-1-data');
      await s1.cleanup(); // snapshot + persist

      // 턴 1의 root를 통째로 삭제(tmpdir 손실 시뮬레이션)
      await fsp.rm(s1.root, { recursive: true, force: true });

      // 턴 2 — 같은 conversationId
      const p2 = new ContinuousWorkspaceProvider(client, store, 'conv-e2e');
      const s2 = await p2.acquire();
      const restored = await fsp.readFile(path.join(s2.root, 'note.txt'), 'utf8');
      expect(restored).toBe('turn-1-data');
      await s2.cleanup();
    } finally {
      await Promise.all([
        fsp.rm(dataDir, { recursive: true, force: true }),
        fsp.rm(snapDir, { recursive: true, force: true }),
        fsp.rm(baseDir, { recursive: true, force: true }),
      ]);
    }
  });
});
```

> 참고: 이 e2e는 `@dongkseo/store-json`을 import 하므로 Task C가 먼저 완료되어야 한다(순서상 보장됨). 패키지 간 dev 의존성이 없으면 단위 fake만으로도 데코레이터 계약은 검증되므로, 만약 워크스페이스 의존성 제약으로 import가 불가하면 이 e2e는 store-json의 `WorkspaceStateStoreJson` 대신 단위 테스트의 `makeStore()` fake로 대체해도 무방(연속성 자체는 client+backend가 보장).

- [ ] **Step 7: 전체 테스트 통과 확인**

Run: `pnpm --filter @dongkseo/core test continuous-workspace-provider`
Expected: PASS (단위 6 + e2e 1). e2e가 환경(tar) 문제로 실패하면 위 참고대로 fake-store 버전으로 대체 후 재실행.

- [ ] **Step 8: 커밋**

```bash
git add packages/core/src/continuous-workspace-provider.ts packages/core/src/index.ts packages/core/src/__tests__/continuous-workspace-provider.test.ts
git commit -m "feat(core): ContinuousWorkspaceProvider — resume-or-acquire + snapshot-on-cleanup"
```

---

## Task G: 전체 빌드 + 회귀 검증

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: 전체 빌드**

Run: `pnpm -r build`
Expected: PASS — 모든 패키지 타입체크 통과.

- [ ] **Step 2: 전체 테스트**

Run: `pnpm test`
Expected: PASS — 신규 테스트 + 기존 회귀 전부 그린. 특히 `workspaceProvider` 미주입 하네스 테스트가 기존과 동일하게 통과(데코레이터 미사용 경로 불변).

- [ ] **Step 3: 설계 문서 상태 갱신 + 커밋**

`docs/superpowers/specs/2026-06-25-workspace-continuity-design.md` 헤더의 `**상태**: 설계 기록 (구현 대기) — draft` 를 다음으로 변경:

```
- **상태**: 구현 완료 (2026-06-25) — `docs/superpowers/plans/2026-06-25-workspace-continuity.md` 참조
```

```bash
git add docs/superpowers/specs/2026-06-25-workspace-continuity-design.md
git commit -m "docs(spec): mark workspace-continuity design as implemented"
```

---

## Self-Review

**1. Spec coverage** (설계 §6.2–6.4 + 테스트 계획 §8):
- §6.2 신규/변경 파일 표 → Task A(fingerprint/contracts/core), B(workspace-state 계약), C(json), D(pg), E(StoreProvider), F(데코레이터). ✅ 전부 매핑.
- §6.3 데이터 모델(`WorkspaceSnapshot.fingerprint`, `WorkspaceStateStore`) → Task A Step1, Task B Step1. ✅
- §6.4 hot/cold 분기 → Task A Step8. ✅
- §6.5 suspend/resume 갭(공짜) → 데코레이터+conversationId 일원화로 자동 충족(별도 코드 불필요, 설계 명시). ✅ 비작업.
- §7 에러처리(best-effort snapshot, load 폴백, corrupt ref) → Task F Step1 테스트 4·5번 + 구현 try/catch. ✅
- §8 테스트 계획: (1) continuous-workspace-provider.test → Task F; (2) fingerprint hot/cold → Task A Step6; (3) workspace-state.test json → Task C(pg는 빌드 게이트, §9.3대로 pg 단위테스트 비목표); (4) 회귀 → Task G Step2. ✅
- §9.1 fingerprint 포함 → 포함(Task A). §9.2 알고리즘 → 전체 SHA256 v1(주석에 후속 명시). §9.3 backend 범위 → json+pg 둘 다. §9.4 retention → `delete` 제공(자동 호출 와이어링은 비목표/소비자). §9.5 증분 → 비목표. ✅

**2. Placeholder scan:** 모든 코드 스텝에 완전한 코드 포함. "TBD/적절히/등" 없음. ✅

**3. Type consistency:**
- `WorkspaceStateStore.{load,save,delete}` 시그니처 — 계약(B)·json(C)·pg(D)·데코레이터(F)·fake(F 테스트) 전부 `load(id):Promise<WorkspaceSnapshot|null>`, `save(id,snap):Promise<void>`, `delete(id):Promise<void>`로 일치. ✅
- `fingerprintRoot(dir):Promise<string>` — 정의(A Step4)·사용(A Step8 resume)·export(A Step9) 일치. ✅
- `WorkspaceSnapshot.fingerprint?` — 추가(A Step1)·기록(A Step8 snapshot)·비교(A Step8 resume)·저장(C/D/F) 일치. ✅
- `ResumableWorkspaceProvider.resume` vs `AsrtSandboxClient.resume` — 둘 다 `(state:WorkspaceSnapshot)=>Promise<WorkspaceSession>`. ✅
- provider 필드명 `workspaceState` — json(C)·pg(D)·StoreProvider(E) 일치. ✅
