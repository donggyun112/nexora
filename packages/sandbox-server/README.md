# @dongkseo/sandbox-server

**Stability: experimental** · `pnpm add @dongkseo/sandbox-server`

> Nexora sandbox **wire 프로토콜의 참조 서버**. 주입한 `SandboxClient` backend를 HTTP로 노출해,
> 원격 `@dongkseo/sandbox-remote` 클라이언트가 로컬처럼 구동하게 한다.

## 무엇인가 / 무엇이 아닌가

- ✅ 담는 것: `createSandboxServer({ client, token?, archiveLimits? })` — Node `http.Server`를 만들어 세션
  프로비저닝·원격 exec·파일 I/O·워크스페이스 persist/hydrate·reattach·delete 라우트를 제공. bearer 인증,
  요청당 경로 재검증, persist/hydrate는 하드닝된 `writeTar`/`safeExtractTar`(`@dongkseo/contracts`) 사용.
- ❌ 안 담는 것: 격리 그 자체 — **주입식 `SandboxClient`에 위임**한다(예: `@dongkseo/core`의 `AsrtSandboxClient`,
  또는 후속 컨테이너 backend). 그래서 이 패키지는 `@dongkseo/contracts`에만 의존한다.

## 핵심 개념 — 라우트

| 라우트 | 용도 |
|---|---|
| `POST /sessions` | 세션 provision(manifest seed) → `{ sessionId, root }` |
| `POST /sessions/:id/exec` | `SandboxCommandResult` 반환(버퍼링; SSE/PTY는 후속) |
| `GET·PUT /sessions/:id/fs?path=` | 파일 read/write(경로 root-jail 재검증, 탈출은 403) |
| `POST /sessions/:id/persist` | 워크스페이스를 tar로 스트림 |
| `POST /sessions/:id/hydrate` | tar 업로드 → 서버 root로 **안전 추출**(zip-slip/symlink/한도 거부) |
| `POST /sessions/:id/reattach` | 세션 생존 여부 → `{ alive, root? }` |
| `DELETE /sessions/:id` | 세션/자원 해제 |

실패는 전부 `{ code, message, retryable }` 정규화 envelope. 자격증명은 어떤 응답에도 실리지 않는다.

## 사용 레시피

```ts
import { createSandboxServer } from '@dongkseo/sandbox-server';
import { AsrtSandboxClient } from '@dongkseo/core'; // 서버 노드의 실제 OS 격리 backend

const server = createSandboxServer({
  client: new AsrtSandboxClient({ perRun: true, allowedDomains: [] }),
  token: process.env.SBX_TOKEN,
});
server.listen(8787);
```

## API 표면 (소스 안 열고 타입만)

```
ctx_read(path="packages/sandbox-server/src/index.ts",  mode="map")
ctx_read(path="packages/sandbox-server/src/server.ts", mode="signatures")
```

## 유지보수 (drift 방지)

- wire DTO 정본은 `@dongkseo/contracts`의 `sandbox-protocol.ts`. 라우트 변경 시 클라이언트와 동시 갱신.
- persist/hydrate 안전성은 contracts의 `safe-archive.ts`가 담보 — 서버는 그걸 호출만 한다.

## Tests

```bash
cd packages/sandbox-server && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
