# ArtifactChannel — nexora Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nexora `Store` backbone 위에 conversationId(scope) 키 **ArtifactChannel** 을 신설한다 — 에이전트가 산출물을 `publish`(ref 반환)하고 다른 에이전트가 `fetch(ref)`로 받는, 로컬 파일 공유(`.scratch/shared`, 로컬 `ImageArtifactStore`)를 대체할 격리-유지 공유 채널.

**Architecture:** 기존 store 패턴을 그대로 미러링한다 — 계약은 `@dongkseo/contracts`, dev 백엔드는 `@dongkseo/store-json`(디스크), 프로덕션 백엔드는 `@dongkseo/store-pg`(BYTEA), 번들은 `@dongkseo/store` 팩토리. 바이너리 저장은 이미 존재하는 `nexora_transcript_attachment`(BYTEA) / store-json 첨부 파일 패턴을 따른다. TTL 은 lazy-read 가 아니라 명시적 `cleanup()` 스윕으로 실현한다(결정적 테스트).

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, `postgres` (postgres.js), pnpm workspace (`@dongkseo/contracts`, `@dongkseo/store-json`, `@dongkseo/store-pg`, `@dongkseo/store`).

상위 설계: `docs/superpowers/specs/2026-06-24-runtime-isolation-adoption-design.md` §3-레이어③ + §4.2.

## Global Constraints

- **하위 호환**: `StoreProvider`/`JsonStoreProvider`/`PgStoreProvider` 에 `artifact` 를 추가할 때, 두 팩토리(`createJsonStoreProvider`, `createPgStoreProvider`)가 **동시에** 해당 필드를 생산하도록 같은 태스크에서 묶는다 — 중간 빌드가 깨지지 않는다. `StoreProvider` 는 팩토리만 생산하고 소비자는 읽기만 하므로(레포 전역 literal 생성 0건, 검증됨) 필드 추가는 안전.
- **ref 는 globally-unique uuid** (`crypto.randomUUID()`). `fetch(ref)` 는 scope 없이 ref 만으로 조회 가능해야 한다(consumer 는 메시지로 ref 만 받는다).
- **TTL = cleanup 스윕**: `fetch`/`list` 는 만료를 lazy 검사하지 않는다. 만료 제거는 `cleanup(now?)` 단독 책임. 시간 주입(`now?` 파라미터)으로 테스트는 결정적.
- **시각 단위**: `createdAt`/`expiresAt` 는 epoch **밀리초**(`number`). PG 컬럼은 `BIGINT`(TZ 변환 회피).
- **바이너리 타입**: `Buffer` (스트림은 YAGNI — 기존 `putAttachment(data: Buffer)` 와 동일).
- **백엔드 특성**: store-json `{ name:'json-file', type:'dev', durable:true, multiProcess:false }`, store-pg `{ name:'postgresql', type:'production', durable:true, multiProcess:true }` — 기존 store 와 동일.
- **테스트 러너**: `pnpm --filter @dongkseo/store-json test` (vitest). store-pg 는 라이브 DB 필요 → CI 단위테스트 없음(레포 컨벤션), `pnpm --filter @dongkseo/store-pg build` 로 타입 검증.
- **커밋**: AI 서명/Co-Authored-By 금지 (전역 규칙).

---

### Task 1: ArtifactChannel 계약 + store-json 백엔드

**Files:**
- Modify: `packages/contracts/src/store.ts` (파일 끝에 ArtifactChannel 계약 추가)
- Modify: `packages/contracts/src/index.ts:200-217` (export 블록에 3개 타입 추가)
- Create: `packages/store-json/src/artifact.ts`
- Modify: `packages/store-json/src/index.ts` (export + 섹션맵 한 줄 — provider 배선은 Task 3)
- Test: `packages/store-json/src/__tests__/artifact.test.ts`

**Interfaces:**
- Consumes: `DescribableStore`, `StoreBackendInfo` (from `@dongkseo/contracts`), `crypto.randomUUID`, `node:fs`/`node:fs/promises`/`node:path`.
- Produces:
  - `ArtifactRef { ref: string; scope: string; name: string; mediaType: string; size: number; createdAt: number; expiresAt?: number; meta?: Record<string, unknown> }`
  - `ArtifactPublishOptions { mediaType?: string; ttlMs?: number; meta?: Record<string, unknown> }`
  - `ArtifactChannel` 인터페이스 (publish/fetch/list/delete/cleanup — 시그니처는 Step 1 계약 참조)
  - `class ArtifactChannelJson implements ArtifactChannel, DescribableStore` — 생성자 `(dataDir: string)`.

- [ ] **Step 1: 계약 추가 (contracts/src/store.ts 파일 끝)**

`packages/contracts/src/store.ts` 맨 아래에 추가:

```typescript
// ─── Artifact Channel ─────────────────────────────────────────────────────
// 에이전트 간 산출물 공유 — conversationId(scope) 키. 로컬 파일 공유(.scratch) 대체.
// producer가 자기 샌드박스 산출물을 publish(ref 반환) → ref를 메시지로 전달 →
// consumer가 fetch(ref)로 bytes 수령. 격리 유지, 명시적 계약, TTL은 cleanup 스윕으로 실현.

export interface ArtifactRef {
  /** Globally-unique opaque handle. fetch()는 이것만으로 조회 가능. */
  ref: string;
  /** 소유 스코프 (conversationId 또는 tenant+conversation). */
  scope: string;
  /** 사람이 읽는 이름 (예: 'slide-1.png'). */
  name: string;
  /** MIME 타입. 기본 application/octet-stream. */
  mediaType: string;
  /** 바이트 크기. */
  size: number;
  /** 생성 시각 (epoch ms). */
  createdAt: number;
  /** 만료 시각 (epoch ms). 없으면 무기한. */
  expiresAt?: number;
  /** 임의 메타데이터. */
  meta?: Record<string, unknown>;
}

export interface ArtifactPublishOptions {
  /** MIME 타입. 기본 application/octet-stream. */
  mediaType?: string;
  /** 생존 기간(ms). 지나면 cleanup()이 제거. 없으면 무기한. */
  ttlMs?: number;
  /** 임의 메타데이터. */
  meta?: Record<string, unknown>;
}

export interface ArtifactChannel {
  /** 산출물 게시 → ref 반환. */
  publish(
    scope: string,
    name: string,
    bytes: Buffer,
    options?: ArtifactPublishOptions,
  ): Promise<ArtifactRef>;
  /** ref로 바이트 조회. 없으면 null. (만료는 검사하지 않음 — cleanup 책임.) */
  fetch(ref: string): Promise<Buffer | null>;
  /** scope의 아티팩트 메타 목록 (바이트 제외), createdAt 오름차순. */
  list(scope: string): Promise<ArtifactRef[]>;
  /** ref 삭제 (없으면 no-op). */
  delete(ref: string): Promise<void>;
  /** expiresAt <= now 인 아티팩트 제거 → 제거 개수. now 기본 Date.now(). */
  cleanup(now?: number): Promise<number>;
}
```

그리고 `packages/contracts/src/index.ts:200-217` 의 `from './store.js'` export 블록 안(`ToolContextRecord,` 다음 줄)에 추가:

```typescript
  ArtifactChannel,
  ArtifactRef,
  ArtifactPublishOptions,
```

- [ ] **Step 2: Write the failing test**

`packages/store-json/src/__tests__/artifact.test.ts` 생성:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactChannelJson } from '../artifact.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-artifact-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ArtifactChannelJson', () => {
  it('round-trip: publish → fetch → list → delete', async () => {
    const ch = new ArtifactChannelJson(tmpDir);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const ref = await ch.publish('conv-1', 'slide-1.png', bytes, { mediaType: 'image/png' });
    expect(ref.ref).toMatch(/[0-9a-f-]{36}/);
    expect(ref.scope).toBe('conv-1');
    expect(ref.name).toBe('slide-1.png');
    expect(ref.mediaType).toBe('image/png');
    expect(ref.size).toBe(4);

    const got = await ch.fetch(ref.ref);
    expect(got).not.toBeNull();
    expect(Buffer.compare(got!, bytes)).toBe(0);

    const listed = await ch.list('conv-1');
    expect(listed).toHaveLength(1);
    expect(listed[0].ref).toBe(ref.ref);
    expect(listed[0].name).toBe('slide-1.png');

    await ch.delete(ref.ref);
    expect(await ch.fetch(ref.ref)).toBeNull();
    expect(await ch.list('conv-1')).toHaveLength(0);
  });

  it('defaults mediaType to application/octet-stream and persists meta', async () => {
    const ch = new ArtifactChannelJson(tmpDir);
    const ref = await ch.publish('conv-1', 'blob.bin', Buffer.from('x'), {
      meta: { producer: 'image-gen-agent' },
    });
    expect(ref.mediaType).toBe('application/octet-stream');
    const listed = await ch.list('conv-1');
    expect(listed[0].meta).toEqual({ producer: 'image-gen-agent' });
  });

  it('list isolates by scope', async () => {
    const ch = new ArtifactChannelJson(tmpDir);
    await ch.publish('conv-a', 'a.bin', Buffer.from('a'));
    await ch.publish('conv-b', 'b.bin', Buffer.from('b'));
    expect(await ch.list('conv-a')).toHaveLength(1);
    expect((await ch.list('conv-a'))[0].name).toBe('a.bin');
  });

  it('fetch returns null for unknown or malformed ref', async () => {
    const ch = new ArtifactChannelJson(tmpDir);
    expect(await ch.fetch('does-not-exist')).toBeNull();
    expect(await ch.fetch('../escape')).toBeNull();
  });

  it('cleanup removes only expired artifacts (deterministic via now)', async () => {
    const ch = new ArtifactChannelJson(tmpDir);
    const expiring = await ch.publish('conv-1', 'tmp.bin', Buffer.from('1'), { ttlMs: 1000 });
    const permanent = await ch.publish('conv-1', 'keep.bin', Buffer.from('2'));

    const before = expiring.createdAt + 500;
    expect(await ch.cleanup(before)).toBe(0);
    expect(await ch.fetch(expiring.ref)).not.toBeNull();

    const after = expiring.createdAt + 1500;
    expect(await ch.cleanup(after)).toBe(1);
    expect(await ch.fetch(expiring.ref)).toBeNull();
    expect(await ch.fetch(permanent.ref)).not.toBeNull();
  });

  it('describeBackend reports dev json-file', async () => {
    const ch = new ArtifactChannelJson(tmpDir);
    expect(ch.describeBackend()).toEqual({
      name: 'json-file', type: 'dev', durable: true, multiProcess: false,
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @dongkseo/store-json test -- artifact`
Expected: FAIL — `Cannot find module '../artifact.js'` (구현 미존재).

- [ ] **Step 4: Implement ArtifactChannelJson**

`packages/store-json/src/artifact.ts` 생성:

```typescript
/**
 * ArtifactChannelJson — conversationId(scope) 키 산출물 공유 (dev 백엔드).
 *
 * 파일 구조 (ref = uuid → scope 없이 ref만으로 fetch 가능):
 *   {dataDir}/artifacts/{ref}.bin   — 바이트
 *   {dataDir}/artifacts/{ref}.json  — 메타 사이드카 (ArtifactRef, 바이트 제외)
 * 참고: transcript.ts 첨부 패턴.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ArtifactChannel,
  ArtifactRef,
  ArtifactPublishOptions,
  StoreBackendInfo,
  DescribableStore,
} from '@dongkseo/contracts';

/** ref는 uuid만 허용 — 경로 탈출 차단. */
function isSafeRef(ref: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(ref);
}

export class ArtifactChannelJson implements ArtifactChannel, DescribableStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'artifacts');
  }

  describeBackend(): StoreBackendInfo {
    return { name: 'json-file', type: 'dev', durable: true, multiProcess: false };
  }

  private binPath(ref: string): string {
    return path.join(this.dir, `${ref}.bin`);
  }

  private metaPath(ref: string): string {
    return path.join(this.dir, `${ref}.json`);
  }

  async publish(
    scope: string,
    name: string,
    bytes: Buffer,
    options?: ArtifactPublishOptions,
  ): Promise<ArtifactRef> {
    await fsp.mkdir(this.dir, { recursive: true });
    const ref = randomUUID();
    const createdAt = Date.now();
    const meta: ArtifactRef = {
      ref,
      scope,
      name,
      mediaType: options?.mediaType ?? 'application/octet-stream',
      size: bytes.length,
      createdAt,
      ...(options?.ttlMs != null ? { expiresAt: createdAt + options.ttlMs } : {}),
      ...(options?.meta !== undefined ? { meta: options.meta } : {}),
    };
    await fsp.writeFile(this.binPath(ref), bytes, { mode: 0o600 });
    await fsp.writeFile(this.metaPath(ref), JSON.stringify(meta), { mode: 0o600 });
    return meta;
  }

  async fetch(ref: string): Promise<Buffer | null> {
    if (!isSafeRef(ref)) return null;
    try {
      return await fsp.readFile(this.binPath(ref));
    } catch {
      return null;
    }
  }

  async list(scope: string): Promise<ArtifactRef[]> {
    if (!fs.existsSync(this.dir)) return [];
    const files = (await fsp.readdir(this.dir)).filter(f => f.endsWith('.json'));
    const refs: ArtifactRef[] = [];
    for (const file of files) {
      const raw = await fsp.readFile(path.join(this.dir, file), 'utf-8');
      const meta = JSON.parse(raw) as ArtifactRef;
      if (meta.scope === scope) refs.push(meta);
    }
    refs.sort((a, b) => a.createdAt - b.createdAt);
    return refs;
  }

  async delete(ref: string): Promise<void> {
    if (!isSafeRef(ref)) return;
    await fsp.rm(this.binPath(ref), { force: true });
    await fsp.rm(this.metaPath(ref), { force: true });
  }

  async cleanup(now: number = Date.now()): Promise<number> {
    if (!fs.existsSync(this.dir)) return 0;
    const files = (await fsp.readdir(this.dir)).filter(f => f.endsWith('.json'));
    let removed = 0;
    for (const file of files) {
      const raw = await fsp.readFile(path.join(this.dir, file), 'utf-8');
      const meta = JSON.parse(raw) as ArtifactRef;
      if (meta.expiresAt != null && meta.expiresAt <= now) {
        await this.delete(meta.ref);
        removed++;
      }
    }
    return removed;
  }
}
```

그리고 `packages/store-json/src/index.ts` 의 export 목록(다른 `export { ... } from` 들과 함께)에 추가:

```typescript
export { ArtifactChannelJson } from './artifact.js';
```

상단 섹션맵 주석에 한 줄 추가(`Suspended turn` 줄 아래):

```typescript
//   Artifact       ./artifact         ArtifactChannelJson          (에이전트 간 산출물 공유)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dongkseo/store-json test -- artifact`
Expected: 6개 PASS. 기존 store-json 테스트 회귀 없어야 함 → `pnpm --filter @dongkseo/store-json test` 전체 그린.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/store.ts packages/contracts/src/index.ts \
  packages/store-json/src/artifact.ts packages/store-json/src/index.ts \
  packages/store-json/src/__tests__/artifact.test.ts
git commit -m "feat(store): ArtifactChannel 계약 + store-json 백엔드"
```

---

### Task 2: store-pg 백엔드 + 마이그레이션

**Files:**
- Modify: `packages/store-pg/src/pg-client.ts:41-197` (migrate() 에 `nexora_artifacts` 테이블 + 인덱스 추가)
- Create: `packages/store-pg/src/artifact.ts`
- Modify: `packages/store-pg/src/index.ts` (export + 섹션맵 — provider 배선은 Task 3)

**Interfaces:**
- Consumes: `ArtifactChannel`, `ArtifactRef`, `ArtifactPublishOptions`, `DescribableStore`, `StoreBackendInfo` (from `@dongkseo/contracts`), `Sql` (from `./pg-client.js`), `crypto.randomUUID`.
- Produces: `class ArtifactChannelPg implements ArtifactChannel, DescribableStore` — 생성자 `(sql: Sql)`.

- [ ] **Step 1: Add migration table (pg-client.ts)**

`packages/store-pg/src/pg-client.ts` 의 `migrate()` 함수 안, `nexora_transcript_attachment` CREATE 블록 다음(L196 닫는 `` ` `` 뒤)에 추가:

```typescript
  await sql`
    CREATE TABLE IF NOT EXISTS nexora_artifacts (
      ref         TEXT PRIMARY KEY,
      scope       TEXT NOT NULL,
      name        TEXT NOT NULL,
      media_type  TEXT NOT NULL,
      size        BIGINT NOT NULL,
      created_at  BIGINT NOT NULL,
      expires_at  BIGINT,
      meta        JSONB,
      data        BYTEA NOT NULL
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_nexora_artifacts_scope ON nexora_artifacts(scope)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_nexora_artifacts_expires ON nexora_artifacts(expires_at)
  `;
```

- [ ] **Step 2: Implement ArtifactChannelPg**

`packages/store-pg/src/artifact.ts` 생성:

```typescript
/**
 * ArtifactChannelPg — PostgreSQL-backed 산출물 공유 채널.
 *
 * 바이트는 bytea, 메타는 컬럼 + jsonb. ref는 globally-unique PK라
 * fetch는 scope 없이 ref만으로 조회한다. TTL은 cleanup 스윕으로 실현.
 * 참고: transcript.ts putAttachment/getAttachment (bytea 패턴).
 */

import { randomUUID } from 'node:crypto';

import type {
  ArtifactChannel,
  ArtifactRef,
  ArtifactPublishOptions,
  StoreBackendInfo,
  DescribableStore,
} from '@dongkseo/contracts';

import type { Sql } from './pg-client.js';

interface ArtifactMetaRow {
  ref: string;
  scope: string;
  name: string;
  media_type: string;
  size: string | number;
  created_at: string | number;
  expires_at: string | number | null;
  meta: Record<string, unknown> | null;
}

interface ArtifactDataRow {
  data: Buffer;
}

function rowToRef(r: ArtifactMetaRow): ArtifactRef {
  const expiresAt = r.expires_at != null ? Number(r.expires_at) : undefined;
  return {
    ref: r.ref,
    scope: r.scope,
    name: r.name,
    mediaType: r.media_type,
    size: Number(r.size),
    createdAt: Number(r.created_at),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(r.meta != null ? { meta: r.meta } : {}),
  };
}

export class ArtifactChannelPg implements ArtifactChannel, DescribableStore {
  constructor(private readonly sql: Sql) {}

  describeBackend(): StoreBackendInfo {
    return { name: 'postgresql', type: 'production', durable: true, multiProcess: true };
  }

  async publish(
    scope: string,
    name: string,
    bytes: Buffer,
    options?: ArtifactPublishOptions,
  ): Promise<ArtifactRef> {
    const ref = randomUUID();
    const mediaType = options?.mediaType ?? 'application/octet-stream';
    const createdAt = Date.now();
    const expiresAt = options?.ttlMs != null ? createdAt + options.ttlMs : null;
    const meta = options?.meta ?? null;
    await this.sql`
      INSERT INTO nexora_artifacts (ref, scope, name, media_type, size, created_at, expires_at, meta, data)
      VALUES (${ref}, ${scope}, ${name}, ${mediaType}, ${bytes.length}, ${createdAt},
              ${expiresAt}, ${meta != null ? this.sql.json(meta as never) : null}, ${bytes})
    `;
    return {
      ref, scope, name, mediaType, size: bytes.length, createdAt,
      ...(expiresAt != null ? { expiresAt } : {}),
      ...(meta != null ? { meta } : {}),
    };
  }

  async fetch(ref: string): Promise<Buffer | null> {
    const rows = (await this.sql`
      SELECT data FROM nexora_artifacts WHERE ref = ${ref}
    `) as unknown as ArtifactDataRow[];
    return rows.length > 0 ? Buffer.from(rows[0]!.data) : null;
  }

  async list(scope: string): Promise<ArtifactRef[]> {
    const rows = (await this.sql`
      SELECT ref, scope, name, media_type, size, created_at, expires_at, meta
      FROM nexora_artifacts WHERE scope = ${scope}
      ORDER BY created_at ASC
    `) as unknown as ArtifactMetaRow[];
    return rows.map(rowToRef);
  }

  async delete(ref: string): Promise<void> {
    await this.sql`DELETE FROM nexora_artifacts WHERE ref = ${ref}`;
  }

  async cleanup(now: number = Date.now()): Promise<number> {
    const rows = (await this.sql`
      DELETE FROM nexora_artifacts
      WHERE expires_at IS NOT NULL AND expires_at <= ${now}
      RETURNING ref
    `) as unknown as { ref: string }[];
    return rows.length;
  }
}
```

그리고 `packages/store-pg/src/index.ts` 의 export 목록에 추가:

```typescript
export { ArtifactChannelPg } from './artifact.js';
```

상단 섹션맵 주석에 한 줄 추가(`Suspended turn` 줄 아래):

```typescript
//   Artifact       ./artifact         ArtifactChannelPg                (에이전트 간 산출물 공유)
```

- [ ] **Step 3: Type-check (store-pg 는 라이브 DB 없이 빌드로 검증 — 레포 컨벤션)**

Run: `pnpm --filter @dongkseo/store-pg build`
Expected: tsc 클린(에러 0). `ArtifactChannelPg` 가 `ArtifactChannel` 계약을 충족(메서드 시그니처 일치)하는지 컴파일러가 보장.

- [ ] **Step 4: Commit**

```bash
git add packages/store-pg/src/pg-client.ts packages/store-pg/src/artifact.ts packages/store-pg/src/index.ts
git commit -m "feat(store-pg): ArtifactChannel PostgreSQL 백엔드 + nexora_artifacts 마이그레이션"
```

---

### Task 3: 팩토리 배선 (StoreProvider + 두 provider + warnDevStores)

**Files:**
- Modify: `packages/store/src/factory.ts:21-32` (`StoreProvider` 에 `artifact` 추가), `:42-49` (`warnDevStores` 목록에 추가), `:7-19` (import 에 `ArtifactChannel` 추가)
- Modify: `packages/store/src/index.ts:16-36` (re-export 에 ArtifactChannel 타입 3개)
- Modify: `packages/store-json/src/index.ts` (`JsonStoreProvider` + `createJsonStoreProvider` 에 `artifact` 배선)
- Modify: `packages/store-pg/src/index.ts` (`PgStoreProvider` + `createPgStoreProvider` 에 `artifact` 배선)
- Test: `packages/store-json/src/__tests__/artifact.test.ts` (provider 노출 검증 1건 추가)

**Interfaces:**
- Consumes: Task 1/2 의 `ArtifactChannelJson`, `ArtifactChannelPg`, `ArtifactChannel` 계약.
- Produces: `StoreProvider.artifact: ArtifactChannel`, `JsonStoreProvider.artifact: ArtifactChannelJson`, `PgStoreProvider.artifact: ArtifactChannelPg`. 두 팩토리가 동시에 생산하므로 필수 필드 추가가 빌드를 깨지 않는다.

- [ ] **Step 1: Write the failing test (provider 가 artifact 를 노출)**

`packages/store-json/src/__tests__/artifact.test.ts` 의 `describe('ArtifactChannelJson')` 아래에 새 describe 추가:

```typescript
import { createJsonStoreProvider } from '../index.js';

describe('createJsonStoreProvider artifact wiring', () => {
  it('exposes a working artifact channel', async () => {
    const provider = createJsonStoreProvider(tmpDir);
    const ref = await provider.artifact.publish('conv-1', 'x.bin', Buffer.from('hello'));
    const got = await provider.artifact.fetch(ref.ref);
    expect(got!.toString()).toBe('hello');
  });
});
```

(상단의 `import { ArtifactChannelJson } from '../artifact.js';` 는 그대로 두고, `createJsonStoreProvider` import 만 추가.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dongkseo/store-json test -- artifact`
Expected: FAIL — `provider.artifact` 가 `undefined` (Property 'artifact' does not exist on type 'JsonStoreProvider' 컴파일 에러 또는 런타임 undefined).

- [ ] **Step 3: Wire StoreProvider 계약 (store/src/factory.ts)**

`packages/store/src/factory.ts` 의 import 블록(L7-19)에 `ArtifactChannel` 추가:

```typescript
  ToolContextStore,
  ArtifactChannel,
  TreeConversationStore,
```

`StoreProvider` 인터페이스(L21-32)에 필드 추가(`toolContext` 다음):

```typescript
  toolContext: ToolContextStore;
  /** 에이전트 간 산출물 공유 채널 (conversationId 키). */
  artifact: ArtifactChannel;
```

`warnDevStores` 의 stores 배열(L42-49)에 추가:

```typescript
    ['toolContext', provider.toolContext],
    ['artifact', provider.artifact],
```

- [ ] **Step 4: Re-export 타입 (store/src/index.ts)**

`packages/store/src/index.ts` 의 `export type { ... } from '@dongkseo/contracts';`(L16-33) 블록 안에 추가:

```typescript
  ToolContextRecord,
  ArtifactChannel,
  ArtifactRef,
  ArtifactPublishOptions,
```

- [ ] **Step 5: Wire JsonStoreProvider (store-json/src/index.ts)**

`packages/store-json/src/index.ts`:
- 하단 import 블록에 `import { ArtifactChannelJson } from './artifact.js';` 추가.
- `JsonStoreProvider` 인터페이스에 `artifact: ArtifactChannelJson;` 추가(`suspendedTurn` 다음).
- `createJsonStoreProvider` 의 반환 객체에 `artifact: new ArtifactChannelJson(dataDir),` 추가.

- [ ] **Step 6: Wire PgStoreProvider (store-pg/src/index.ts)**

`packages/store-pg/src/index.ts`:
- 하단 import 블록(다른 `import { ...Pg } from './*.js'` 와 함께)에 `import { ArtifactChannelPg } from './artifact.js';` 추가.
- `PgStoreProvider` 인터페이스에 `artifact: ArtifactChannelPg;` 추가(`suspendedTurn` 다음).
- `createPgStoreProvider` 의 반환 객체에 `artifact: new ArtifactChannelPg(sql),` 추가.

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @dongkseo/store-json test -- artifact`
Expected: 7개 PASS (기존 6 + provider wiring 1).

- [ ] **Step 8: 전체 빌드 회귀 검증**

Run: `pnpm -r build` (또는 `pnpm --filter @dongkseo/contracts --filter @dongkseo/store --filter @dongkseo/store-json --filter @dongkseo/store-pg build`)
Expected: tsc 클린. `createStoreProvider` 의 두 분기(json/pg)가 `artifact` 를 포함한 `StoreProvider` 를 반환하므로 타입 일치.

- [ ] **Step 9: Commit**

```bash
git add packages/store/src/factory.ts packages/store/src/index.ts \
  packages/store-json/src/index.ts packages/store-pg/src/index.ts \
  packages/store-json/src/__tests__/artifact.test.ts
git commit -m "feat(store): StoreProvider 에 ArtifactChannel 배선 (json/pg 팩토리 + warnDevStores)"
```

---

## Self-Review

**1. Spec coverage:** 이 플랜은 스펙 §3-레이어③ + §4.2(ArtifactChannel 계약 `publish`/`fetch`/`list` + TTL/cleanup, store-json/store-pg 백엔드, scope=conversationId)를 구현한다. 스펙 §4.2 의 **빌트인 도구**(`share_artifact`/`get_artifact`)는 명시적으로 "(선택)" 표기 — 본 플랜의 store 레이어 위에 얹는 **후속 플랜**으로 분리(에이전트가 명시적으로 주고받는 경로). §4.3 `createSandboxProvider` 헬퍼, §4.4-4.5 in7/ixpert 배선, in7 로컬 `ImageArtifactStore`/`.scratch/shared` **제거**는 각각 별도 플랜(Plan 3/4/5). 의도된 범위 분할 — 본 플랜만으로 store 레이어가 동작·테스트 가능.

**2. Placeholder scan:** TBD/TODO 없음. 모든 코드 스텝에 실제 코드 포함. store-pg 는 라이브 DB 가 CI 에 없어(레포 컨벤션: `store-pg test` 가 echo stub) 빌드 타입검증으로 대체 — 이는 누락이 아니라 레포의 기존 검증 방식.

**3. Type consistency:** `ArtifactChannel`/`ArtifactRef`/`ArtifactPublishOptions` 명칭이 Task 1 계약 → Task 2 PG impl → Task 3 팩토리 전체에서 동일. 메서드 시그니처(`publish(scope, name, bytes, options?)`, `fetch(ref)`, `list(scope)`, `delete(ref)`, `cleanup(now?)`)가 json/pg 양 구현 + 계약에서 일치. `createdAt`/`expiresAt` 는 양쪽 모두 epoch ms `number`(PG 는 BIGINT→`Number()` 변환). `describeBackend` 반환이 기존 store 들과 동일 형태. `ArtifactRef` 의 optional 필드(`expiresAt`/`meta`)는 양 구현에서 조건부 스프레드로 동일하게 생략.
