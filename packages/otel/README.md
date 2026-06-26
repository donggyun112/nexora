# @dongkseo/otel

**Stability: advanced** · `pnpm add @dongkseo/otel`

Nexora를 OpenTelemetry로 계측하는 두 개의 어댑터. HTTP 요청 → 게이트웨이 → 트랜스포트 →
에이전트 부트스트랩 → 아키텍처 루프 → 도구 호출 → 트랜스포트 응답까지를 **하나의 trace**로
Jaeger/Tempo/Honeycomb에서 볼 수 있게 한다.

## 무엇인가 / 무엇이 아닌가

이 패키지는 Nexora의 두 확장 지점에 span을 끼워 넣는 **얇은 계측 레이어**다. `@opentelemetry/api`
(facade)에만 의존하며, 실제 SDK/exporter 설정은 하지 않는다.

- ✅ `EventTransport`를 감싸 publish/subscribe/request마다 span 생성 (`OTelTransport`)
- ✅ `MiddlewarePipeline` 플러그인으로 에이전트 실행 + 도구 호출 span 생성 (`createOTelAgentMiddleware`)
- ✅ Nexora trace/span id를 W3C 포맷으로 변환해 trace 연속성 보장 (`@dongkseo/contracts`의 `toW3CTraceId` 활용)
- ❌ OTLP/Jaeger/console exporter, `NodeSDK`, span processor 설정 — **애플리케이션 책임**
- ❌ 메트릭/로그 계측 (span만 다룸)
- ❌ 트랜스포트/미들웨어 구현 자체 — 기존 구현을 감싸기만 한다

의존 방향: `@dongkseo/otel` → `@dongkseo/contracts`(타입·id 헬퍼) + `@opentelemetry/api`. 역방향 없음.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| **Transport span** | publish/subscribe/request 경계마다 span을 찍는 트랜스포트 래퍼 | `OTelTransport`, `OTelTransportOptions` |
| **Agent span** | 실행 단위 + 각 도구 호출 span을 찍는 미들웨어 플러그인 | `createOTelAgentMiddleware`, `OTelAgentMiddlewareOptions` |
| **기본 속성** | 모든 span에 붙는 공통 attribute (service.name 등) | `defaultAttributes` (양쪽 옵션) |

## 사용 레시피

트랜스포트 감싸기 — 기존 `EventTransport` 구현을 한 줄로 래핑한다:

```ts
import { OTelTransport } from '@dongkseo/otel';
import { trace } from '@opentelemetry/api';

// inner: 기존 EventTransport 구현 (in-memory, NATS 등)
const transport = new OTelTransport(inner, {
  tracer: trace.getTracer('nexora'),          // 생략 시 trace.getTracer('nexora')
  defaultAttributes: {
    'service.name': 'nexora-gateway',
    'deployment.environment': 'prod',
  },
});
// 이제 transport.publish/subscribe/request가 자동으로 span을 남긴다.
```

에이전트 실행 계측 — 미들웨어를 러너에 등록한다 (`AgentRunnerOptions.middlewares`):

```ts
import { createOTelAgentMiddleware } from '@dongkseo/otel';
import { AgentRunner } from '@dongkseo/core';

const runner = new AgentRunner({
  architecture,
  llm,
  tools,
  middlewares: [
    createOTelAgentMiddleware({
      defaultAttributes: { 'service.name': 'nexora-agent' },
    }),
  ],
});
// 실행마다 execution span, 도구 호출마다 child span이 생긴다.
```

> exporter/SDK는 별도로 부트스트랩해야 한다 (애플리케이션 시작 시 `@opentelemetry/sdk-node` 등).
> 이 패키지는 `@opentelemetry/api`로 span만 발행한다.

## API 표면 (소스 안 열고 타입만)

정확한 시그니처가 필요하면 구현 본문 대신 **signatures 모드**로만 읽어라:

```
ctx_read(path="packages/otel/src/transport-middleware.ts", mode="signatures")
ctx_read(path="packages/otel/src/agent-middleware.ts",     mode="signatures")
ctx_read(path="packages/otel/src/index.ts",                mode="map")   # 전체 export 목록
```

어떤 파일에 뭐가 있는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/otel && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
