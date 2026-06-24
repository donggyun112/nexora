# 빌트인 read 이미지 지원 (N1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nexora 빌트인 `read` 도구가 이미지 파일을 만나면 utf-8 텍스트 대신 **vision 블록**(`{ type:'image', data, mimeType }`)을 **원본 바이트(base64)** 로 반환한다 (Claude Code read 툴과 동형). 텍스트 파일 동작은 무변경.

**Architecture:** `createReadTool`의 execute에서 파일 stat·크기캡 통과 후, 경로 확장자가 이미지면 핸들에서 Buffer로 읽어 `{ type:'image', data: buf.toString('base64'), mimeType }` 반환. 최적화(리사이즈)는 하지 않는다 — 소비자(in7)가 필요 시 read를 래핑해 처리(관심사 분리). `ToolResult` 유니언은 이미 `{ type:'image'; data:string; mimeType:string }`를 포함(`contracts/src/tool.ts:117`).

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, `@dongkseo/tools`(`@dongkseo/contracts` 의존).

상위 설계: `~/Works/in7-marketing-poc/docs/superpowers/specs/2026-06-25-in7-unified-tool-model-design.md` §3.1 (결정: nexora=raw, 최적화=in7).

## Global Constraints

- **원본 바이트만**: read는 sharp 등으로 리사이즈/재인코딩하지 않는다. nexora tools에 새 무거운 의존성 추가 금지. 토큰 최적화는 in7이 read 래퍼로 담당(후속).
- **이미지 판정 = 확장자**: `.png`/`.jpg`/`.jpeg`/`.webp`/`.gif` (소문자 비교). mimeType 매핑: png→`image/png`, jpg/jpeg→`image/jpeg`, webp→`image/webp`, gif→`image/gif`. (매직바이트 판정은 YAGNI — 확장자로 충분.)
- **텍스트 경로 무변경**: 비이미지 확장자는 기존 utf-8 줄번호 동작 그대로. `offset`/`limit`는 이미지에 무의미 — 이미지 경로에선 무시(전체 바이트 반환).
- **기존 가드 유지**: O_NOFOLLOW fd 오픈(`openForRead`), 워크스페이스 경계, 8MB 크기 캡은 이미지에도 동일 적용. 디렉토리 경로는 기존대로 listing.
- **반환 형태**: `{ type: 'image', data: <base64>, mimeType: <매핑값> }` 객체 리터럴 직접 반환(`view-reference-image`와 동형). `textResult`/`errorResult` 헬퍼는 텍스트/에러 경로 유지.
- **커밋**: AI 서명/Co-Authored-By 금지.
- **테스트 러너**: `pnpm --filter @dongkseo/tools test`.

---

### Task 1: read 이미지 분기 + 테스트

**Files:**
- Modify: `packages/tools/src/builtin/read.ts` (이미지 분기 추가 + 헬퍼)
- Test: `packages/tools/src/__tests__/read-image.test.ts` (생성; 기존 read 테스트 위치 관례 따름 — 없으면 이 경로)

**Interfaces:**
- Consumes: `node:path`(extname), 기존 `openForRead`/`resolveToolPath`, `ToolResult`(이미 import), `FileHandle.readFile()`(인코딩 없이 → Buffer).
- Produces: `read`가 이미지 확장자 파일에 `{ type:'image', data, mimeType }` 반환. (외부 시그니처 무변경 — `createReadTool(): ToolDefinition`.)

- [ ] **Step 1: Write the failing test**

먼저 기존 read 테스트 위치 확인: `ls packages/tools/src/__tests__/ | grep -i read` (없으면 아래 경로로 생성). `packages/tools/src/__tests__/read-image.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReadTool } from '../builtin/read.js';
import type { ToolContext, ToolResult } from '@dongkseo/contracts';

let dir: string;
const ctx = (): ToolContext =>
  ({ tenantId: 't', workdir: dir, secrets: { get: async () => undefined }, logger: console } as unknown as ToolContext);

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-read-img-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('read — image files', () => {
  it('returns a vision block with raw base64 for a .png', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    fs.writeFileSync(path.join(dir, 'pic.png'), bytes);
    const read = createReadTool();
    const res = (await read.execute('1', { path: 'pic.png' }, ctx())) as Extract<ToolResult, { type: 'image' }>;
    expect(res.type).toBe('image');
    expect(res.mimeType).toBe('image/png');
    expect(res.data).toBe(bytes.toString('base64'));
  });

  it('maps jpg/jpeg/webp/gif mime types', async () => {
    const cases: [string, string][] = [
      ['a.jpg', 'image/jpeg'], ['a.jpeg', 'image/jpeg'], ['a.webp', 'image/webp'], ['a.gif', 'image/gif'],
    ];
    const read = createReadTool();
    for (const [name, mime] of cases) {
      fs.writeFileSync(path.join(dir, name), Buffer.from([1, 2, 3]));
      const res = (await read.execute('1', { path: name }, ctx())) as Extract<ToolResult, { type: 'image' }>;
      expect(res.type).toBe('image');
      expect(res.mimeType).toBe(mime);
    }
  });

  it('uppercase extension is treated as image', async () => {
    fs.writeFileSync(path.join(dir, 'P.PNG'), Buffer.from([9, 9, 9]));
    const read = createReadTool();
    const res = (await read.execute('1', { path: 'P.PNG' }, ctx())) as Extract<ToolResult, { type: 'image' }>;
    expect(res.type).toBe('image');
    expect(res.mimeType).toBe('image/png');
  });

  it('non-image files still return numbered text (unchanged)', async () => {
    fs.writeFileSync(path.join(dir, 'note.txt'), 'hello\nworld');
    const read = createReadTool();
    const res = (await read.execute('1', { path: 'note.txt' }, ctx())) as Extract<ToolResult, { type: 'text' }>;
    expect(res.type).toBe('text');
    expect(res.text).toContain('hello');
    expect(res.text).toContain('world');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dongkseo/tools test -- read-image`
Expected: FAIL — 이미지 케이스가 `type:'text'`(깨진 utf-8) 반환, `type:'image'` 기대와 불일치.

- [ ] **Step 3: Add the image branch to read.ts**

`packages/tools/src/builtin/read.ts` 상단 import에 `node:path` 추가:

```typescript
import path from 'node:path';
```

모듈 상단(상수 `MAX_BYTES` 인근)에 매핑 추가:

```typescript
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
```

`execute` 내부, 크기 캡 검사(`if (stat.size > MAX_BYTES) ...`) **직후**, utf-8 readFile **이전**에 이미지 분기 삽입:

```typescript
        const imageMime = IMAGE_MIME_BY_EXT[path.extname(toolPath).toLowerCase()];
        if (imageMime) {
          const bytes = await handle.readFile();
          return { type: 'image', data: bytes.toString('base64'), mimeType: imageMime };
        }
```

(이후 기존 `const content = await handle.readFile('utf-8'); ...` 텍스트 경로는 그대로.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dongkseo/tools test -- read-image`
Expected: 4 PASS.

- [ ] **Step 5: Regression — full tools suite**

Run: `pnpm --filter @dongkseo/tools test`
Expected: 기존 전부 그린(텍스트 read 경로 무변경) + 새 4개. `pnpm --filter @dongkseo/tools build` tsc 클린.

- [ ] **Step 6: Commit**

```bash
git add packages/tools/src/builtin/read.ts packages/tools/src/__tests__/read-image.test.ts
git commit -m "feat(tools): builtin read 가 이미지 파일을 vision 블록(원본 바이트)으로 반환"
```

---

## Self-Review

**1. Spec coverage:** 통합 모델 §3.1의 "read 이미지 인식, nexora=raw" 결정을 구현한다. 최적화(sharp)는 명시적으로 in7 후속(N1b, 슬라이스 ③c와 함께) — 범위 밖.

**2. Placeholder scan:** TBD/TODO 없음. 모든 스텝 실제 코드 포함. 테스트 위치는 "기존 관례 확인 후 없으면 이 경로" — 구체 지시.

**3. Type consistency:** 반환 `{ type:'image', data:string, mimeType:string }`은 `ToolResult` 유니언(tool.ts:117) 및 `view-reference-image`와 동형. `IMAGE_MIME_BY_EXT` 키는 `path.extname().toLowerCase()` 결과(앞점 포함, 소문자)와 일치. 외부 시그니처(`createReadTool(): ToolDefinition`) 무변경.
