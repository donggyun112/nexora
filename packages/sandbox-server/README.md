# @dongkseo/sandbox-server

**Stability: experimental** · `pnpm add @dongkseo/sandbox-server`

> Nexora sandbox **wire 프로토콜의 참조 서버**. 주입한 `SandboxClient` backend를 HTTP로 노출해,
> 원격 `@dongkseo/sandbox-remote` 클라이언트가 로컬처럼 구동하게 한다. 서버 자체는 격리를 소유하지
> 않지만(주입식 backend에 위임), 이 패키지는 조립용으로 **batteries-included backend·세션 lifecycle·
> 네트워크 사이드카**도 함께 export한다.

## 무엇인가 / 무엇이 아닌가

- ✅ 담는 것(서버): `createSandboxServer({ client, token?, archiveLimits?, lifecycle?, archiveStore?, rootAllowPrefixes? })`
  — Node `http.Server`를 만들어 세션 프로비저닝·원격 exec·파일 I/O(read/write/stat/readdir)·워크스페이스
  persist/hydrate·reattach·delete 라우트를 제공. bearer 인증(constant-time), 요청당 경로 재검증,
  persist/hydrate는 하드닝된 `writeTar`/`safeExtractTar`(`@dongkseo/contracts`) 사용. `SessionRegistry`가
  idle-archive/thaw/TTL sweep로 세션 lifecycle을 관리하고, `shutdown()`이 live 세션을 아카이브 후 닫는다.
- ✅ 담는 것(조립 부품): 주입 가능한 OS-격리 backend(`OverlayRootfsSandboxClient`), 아카이브 매체
  (`TarArchiveStore`/`DurableDirStore`), 네트워크 사이드카(`startEgressProxy`/`startAuthInjectingGateway`).
  아래 "함께 제공하는 조각" 참고.
- ❌ 안 담는 것: 서버 라우트 층은 **격리를 실행하지 않는다** — 주입식 `SandboxClient`에 위임한다(예:
  `@dongkseo/core`의 `AsrtSandboxClient`, 또는 이 패키지의 `OverlayRootfsSandboxClient`). 격리 backend를
  주입해도 이 패키지의 런타임 의존성은 여전히 `@dongkseo/contracts` 하나뿐이다(bwrap/커널 기능은
  런타임 호스트가 제공).

## 핵심 개념 — 라우트

| 라우트 | 용도 |
|---|---|
| `POST /sessions` | 세션 provision(manifest seed, optional `rootDir`) → `{ sessionId, root }` |
| `POST /sessions/:id/exec` | `SandboxCommandResult` 반환(버퍼링; SSE/PTY는 후속) |
| `GET·PUT /sessions/:id/fs?path=` | 파일 read/write(경로 root-jail 재검증, 탈출은 403) |
| `GET /sessions/:id/stat?path=` | `{ size, mtimeMs, isFile, isDirectory, mode }`(`lstat`; 없으면 404) |
| `GET /sessions/:id/readdir?path=` | `[{ name, isDirectory }]` |
| `POST /sessions/:id/persist` | 워크스페이스를 tar **bytes**(octet-stream)로 반환 |
| `POST /sessions/:id/hydrate` | tar 업로드 → 서버 root로 **안전 추출**(zip-slip/symlink/한도 거부) |
| `POST /sessions/:id/reattach` | 세션 생존 여부 → `{ alive, root? }`(죽은 세션도 관용) |
| `DELETE /sessions/:id` | 세션/자원 해제 |

실패는 전부 `{ code, message, retryable }` 정규화 envelope. 자격증명은 어떤 응답에도 실리지 않는다.

## 사용 레시피

```ts
import { createSandboxServer } from '@dongkseo/sandbox-server';
import { AsrtSandboxClient } from '@dongkseo/core'; // 서버 노드의 실제 OS 격리 backend

// createSandboxServer 는 { server, shutdown } 핸들을 반환한다(서버 인스턴스 아님).
const { server, shutdown } = createSandboxServer({
  client: new AsrtSandboxClient({ perRun: true, allowedDomains: [] }),
  token: process.env.SBX_TOKEN,
});
server.listen(8787);
// graceful stop: sweep 정지 → live 세션 아카이브 → close
process.on('SIGTERM', () => void shutdown());
```

> 이 패키지의 `OverlayRootfsSandboxClient` 를 `client` 로 주입하면 core 없이도 bwrap 기반 격리로 구동한다.

## 함께 제공하는 조각 (주입 / 조립용)

라우트 층과 별개로 export되는 부품들. **`createSandboxServer` 가 자동 기동하지 않는다** — 필요에 따라 직접 주입/조립한다.

| export | 무엇 | 타입 읽기 |
|---|---|---|
| `OverlayRootfsSandboxClient`, `buildBwrapArgs`, `OverlayRootfsOptions` | bwrap overlay-rootfs 기반 OS-격리 `SandboxClient`. cap-drop, network `none\|share\|proxy`, read-only 마운트, 세션-프라이빗 home. `client` 로 주입. | `mode="signatures"` |
| `SessionRegistry`, `SessionLifecycleOptions` | 세션 lifecycle(acquire/release/reattach/sweep/archive). 서버가 내부 사용; 커스텀 조립 시 export. | `mode="signatures"` |
| `TarArchiveStore`, `DurableDirStore`, `ArchiveStore`, `TarArchiveStoreOptions` | persist된 워크스페이스 아카이브 매체(tar 파일 / durable 디렉토리). `archiveStore` 옵션. | `mode="signatures"` |
| `startEgressProxy`, `isEgressAllowed`, `matchesDomainPattern`, `EgressProxyOptions`, `EgressProxyHandle` | CONNECT egress 프록시 + 도메인 allow/deny. overlay client `network:'proxy'` 의 `egressSocketPath` 뒤를 받치는 **사이드카**. | `mode="signatures"` |
| `startAuthInjectingGateway`, `AuthInjectingGatewayOptions`, `AuthInjectingGatewayHandle` | 잽 안 요청에 auth 헤더를 주입하는 게이트웨이(`ANTHROPIC_BASE_URL` 리다이렉트). `authGatewaySocketPath` 뒤를 받치는 **사이드카**. | `mode="signatures"` |

`rootAllowPrefixes` (server 옵션)는 보안 게이트: `CreateSessionRequest.rootDir` 로 외부 root를 여는 걸 허용된 prefix로 제한한다. 미지정(기본)이면 외부-root 요청은 전부 403. 이 게이트를 통과한 세션은 **non-archivable**로 등록돼 idle sweep이 caller 소유 디렉토리를 tar하지 않고 cleanup도 삭제하지 않는다.

## API 표면 (소스 안 열고 타입만)

```
ctx_read(path="packages/sandbox-server/src/index.ts",                mode="map")          # 전체 export 목록
ctx_read(path="packages/sandbox-server/src/server.ts",               mode="signatures")   # 라우트/옵션
ctx_read(path="packages/sandbox-server/src/overlay-rootfs-client.ts", mode="signatures")  # bwrap backend
ctx_read(path="packages/sandbox-server/src/session-registry.ts",     mode="signatures")   # lifecycle
ctx_read(path="packages/sandbox-server/src/egress-proxy.ts",         mode="signatures")   # egress 사이드카
ctx_read(path="packages/sandbox-server/src/auth-gateway.ts",         mode="signatures")   # auth 사이드카
```

## 유지보수 (drift 방지)

- wire DTO 정본은 `@dongkseo/contracts`의 `sandbox-protocol.ts`. 라우트 변경 시 클라이언트와 동시 갱신.
- persist/hydrate 안전성은 contracts의 `safe-archive.ts`가 담보 — 서버는 그걸 호출만 한다.
- `OverlayRootfsSandboxClient`/사이드카는 런타임 호스트에 bwrap·커널 기능·unix 소켓을 요구한다(패키지 의존성 아님). 구동 전 `selfCheck()`로 확인.

## Tests

```bash
cd packages/sandbox-server && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
