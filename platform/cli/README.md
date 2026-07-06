# @dongkseo/cli

**Stability: stable** · `pnpm add @dongkseo/cli` · bin: `nexora`

> 이 파일은 에이전트(사람·LLM)가 소스를 열지 않고도 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> CLI는 라이브러리가 아니라 **명령** 중심이다. 정확한 프로그래매틱 타입은 `signatures`로 읽어라.

## 무엇인가 / 무엇이 아닌가

Nexora 개발/운영 **CLI**다. 에이전트를 스캐폴드하고, dev 서버를 띄우고, 진단·DLQ·예산·handraise를 본다. 같은 기능을 코드에서 부를 수 있게 프로그래매틱 API도 export한다.

- ✅ 담는 것: `nexora` 명령(create/dev/doctor/dlq/budget/handraise/export/import), 프로그래매틱 함수(`scaffoldAgent`, `runDev`, `runDoctor`, `viewDlq`, `viewBudget`, `viewHandraises`, `exportPackage`, `importPackage`)
- ❌ 안 담는 것: 런타임 엔진(→ `@dongkseo/core`), 트랜스포트(→ `@dongkseo/transport`), 게이트웨이(→ `@dongkseo/gateway`)

## 핵심 개념 (명령 ↔ 프로그래매틱 API)

| 명령 | 무엇 | 프로그래매틱 export |
| --- | --- | --- |
| `nexora create agent <name>` | 에이전트 스캐폴드 | `scaffoldAgent` |
| `nexora dev` | dev 서버 부팅(어댑터+로컬 트랜스포트) | `runDev` |
| `nexora doctor` | 환경/설정 진단 | `runDoctor` |
| `nexora dlq` | dead-letter 큐 조회 | `viewDlq` |
| `nexora budget` | 예산 사용 조회 | `viewBudget` |
| `nexora handraise` | 대기 중 handraise 조회 | `viewHandraises` |
| `nexora export` / `import` | 에이전트 패키지 내보내기/가져오기 | `exportPackage` / `importPackage` |

## 사용 레시피

CLI:
```bash
pnpm exec nexora create agent my-agent --tools read,grep
pnpm exec nexora dev
# 다른 터미널
curl -X POST localhost:3000/messages -H 'Content-Type: application/json' -d '{"content":"hello"}'
```

프로그래매틱(다른 도구에서 스캐폴딩 호출):
```ts
import { scaffoldAgent, runDev } from '@dongkseo/cli';

await scaffoldAgent({ name: 'my-agent', tools: ['read', 'grep'] });
await runDev();
```

## API 표면 (소스 안 열고 타입만)

```
ctx_read(path="platform/cli/src/index.ts",        mode="map")          # 프로그래매틱 export 전체
ctx_read(path="platform/cli/src/scaffold.ts",     mode="signatures")   # scaffoldAgent, ScaffoldOptions
ctx_read(path="platform/cli/src/ops.ts",          mode="signatures")   # runDoctor, viewDlq, viewBudget, viewHandraises
ctx_read(path="platform/cli/src/portability.ts",  mode="signatures")   # exportPackage, importPackage
```
CLI 진입점(명령 파싱)은 `src/cli.ts` (bin `nexora`).

## 유지보수 (drift 방지)

- 이 README = 목적·명령·레시피만. API 정본은 소스 TSDoc.
- 새 명령/함수가 생기면 이 표와 `src/index.ts`에 한 줄만 추가.

## Tests

```bash
cd platform/cli && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
