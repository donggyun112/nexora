# @dongkseo/sandbox-remote

**Stability: experimental** · `pnpm add @dongkseo/sandbox-remote`

> 원격/클라우드 sandbox에 붙는 `SandboxClient`. 로컬 sandbox 클라이언트를 이걸로 **교체만** 하면
> 에이전트·도구 코드를 바꾸지 않고 워크스페이스 경계를 provider-관리 호스트로 옮긴다(포터빌리티 축).

## 무엇인가 / 무엇이 아닌가

- ✅ 담는 것: `RemoteSandboxClient` — Nexora sandbox wire 프로토콜(`@dongkseo/sandbox-server`)로 원격 세션을
  프로비저닝하고, 원격 exec·워크스페이스 persist/hydrate·**살아있는 세션 reattach**를 수행. `SandboxClient` +
  `WorkspaceProvider` 양쪽을 구현하며 `resume(SandboxSessionState)`를 제공 → `ContinuousWorkspaceProvider`에 그대로 주입 가능.
- ❌ 안 담는 것: OS 격리 그 자체(서버가 자기 backend로 강제한다). 상용 provider 어댑터(Cloudflare/Modal 등 — 후속).

원격 세션은 서버가 격리하므로 **`wrapCommand`를 의도적으로 구현하지 않는다**(로컬에서 감쌀 jail이 없음). detached/background
실행이 필요하면 호스트에서 비격리 spawn으로 폴백하지 말고 서버측 task로 라우팅해야 한다.

## 핵심 개념

- **create** → `POST /sessions`(manifest seed) → 원격 세션.
- **run** → `POST /sessions/:id/exec` → 버퍼링된 `SandboxCommandResult`(기존 seam과 동일).
- **snapshot / sessionState** → `POST /persist`로 tar를 받아 로컬에 스풀 → `SandboxSessionState{ backend:'remote', ref:<원격 세션 id>, snapshot }`.
- **resume** → `ref`가 살아있으면 `POST /reattach`로 **재접속(HOT)**, 아니면 새 세션 + `POST /hydrate`로 **재수화(COLD)**.
- 자격증명(토큰)은 옵션/헤더에만 존재하며 `SandboxSessionState`·로그·에러에 절대 실리지 않는다.

> 참고(후속): 내장 파일 도구(read/grep/edit/write)는 워크스페이스 root에 **로컬 fs**로 접근하므로, 진짜 원격 root에 대한
> 파일 I/O는 `WorkspaceSession`에 read/write 메서드를 추가하고 그 도구들을 리팩터해야 완성된다. wire 프로토콜의 `/fs`가
> 그 토대를 이미 제공한다. 현재 이 클라이언트는 exec + persist/hydrate + reattach를 완결한다.

## 사용 레시피

```ts
import { RemoteSandboxClient } from '@dongkseo/sandbox-remote';
import { ContinuousWorkspaceProvider } from '@dongkseo/core';
import { AgentRunner } from '@dongkseo/core';

const remote = new RemoteSandboxClient({ endpoint: 'https://sbx.example.com', token: process.env.SBX_TOKEN });

// 대화 연속성까지: 원격 세션 재접속/재수화를 conversationId 기준으로.
const provider = new ContinuousWorkspaceProvider(remote, workspaceStateStore, conversationId);

const runner = new AgentRunner({ /* … */, workspaceProvider: provider });
```

로컬↔원격 교체는 `workspaceProvider` 한 줄뿐 — 나머지는 동일.

## API 표면 (소스 안 열고 타입만)

```
ctx_read(path="packages/sandbox-remote/src/index.ts",  mode="map")
ctx_read(path="packages/sandbox-remote/src/client.ts", mode="signatures")
```

## 유지보수 (drift 방지)

- API 정본은 소스 TSDoc. wire DTO 정본은 `@dongkseo/contracts`의 `sandbox-protocol.ts`.
- 프로토콜을 바꾸면 `@dongkseo/sandbox-server`와 동시에 갱신하고 통합 테스트로 고정.

## Tests

```bash
cd packages/sandbox-remote && pnpm test   # 서버를 띄워 end-to-end 포터빌리티 검증
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
