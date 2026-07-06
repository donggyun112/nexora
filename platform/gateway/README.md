# @dongkseo/gateway

**Stability: stable** · `pnpm add @dongkseo/gateway`

> 이 파일은 에이전트(사람·LLM)가 소스를 열지 않고도 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면"의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

외부 진입점(어댑터)과 에이전트 시스템 사이의 **라우터 + 게이트 미들웨어**다. inbound 메시지를 토픽으로 라우팅하고, API 키 인증·레이트리밋을 건다.

- ✅ 담는 것: `GatewayRouter`(transport로 발행), `LocalRuntimeRouter`(transport 없이 런타임 직접 호출·스트리밍), `StreamingGatewayRouter`, 의도 해석기(`createMentionResolver`), 인증·레이트리밋 미들웨어
- ❌ 안 담는 것: HTTP/Discord 등 채널 어댑터(→ `@dongkseo/adapters`), 에이전트 레지스트리 구현(→ `@dongkseo/registry`), 트랜스포트 구현(→ `@dongkseo/transport`)

의존 방향: **gateway → adapters, contracts**. 에이전트/Capability 조회가 필요하면 호출자가 `@dongkseo/registry`로 resolver를 구성해 주입한다.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| **GatewayRouter** | InboundMessage → 토픽 발행 → 응답 수신 (transport 경유) | `GatewayRouter`, `GatewayRouterOptions` |
| **LocalRuntimeRouter** | transport 없이 AgentRuntime 직접 호출(단일 프로세스·스트리밍) | `LocalRuntimeRouter`, `LocalRuntimeRouterOptions` |
| **StreamingGatewayRouter** | 스트리밍 응답 라우터 | `StreamingGatewayRouter`, `StreamingGatewayRouterOptions` |
| **의도 해석기** | 어느 에이전트로 보낼지 결정(멘션 기반 기본 구현) | `createMentionResolver`, `IntentResolver` |
| **게이트 미들웨어** | API 키 인증·레이트리밋·보안 resolver | `createApiKeyAuth`, `createRateLimiter`, `createSecureResolver`, `RateLimitError` |

## 사용 레시피

API 키 인증 + 레이트리밋을 건 게이트웨이 라우터:

```ts
import {
  GatewayRouter, createMentionResolver,
  createApiKeyAuth, createRateLimiter,
} from '@dongkseo/gateway';
import { LocalTransport } from '@dongkseo/transport';

const transport = new LocalTransport();
const router = new GatewayRouter({
  transport,
  resolver: createMentionResolver(),         // 멘션→토픽
  auth: createApiKeyAuth({ keys: [process.env.API_KEY!] }),
  rateLimiter: createRateLimiter({ windowMs: 60_000, max: 60 }), // 초과 시 RateLimitError(429)
});

const reply = await router.handle({ content: '@coder 버그 고쳐줘', apiKey: [REDACTED:API key param] });
```

transport 없이 단일 프로세스로 런타임을 직접 호출하려면 `LocalRuntimeRouter`(스트리밍 지원).

## API 표면 (소스 안 열고 타입만)

```
ctx_read(path="platform/gateway/src/index.ts",            mode="map")        # 전체 export
ctx_read(path="platform/gateway/src/router.ts",           mode="signatures") # GatewayRouter, LocalRuntimeRouter, createMentionResolver
ctx_read(path="platform/gateway/src/streaming-router.ts", mode="signatures") # StreamingGatewayRouter
ctx_read(path="platform/gateway/src/middleware.ts",       mode="signatures") # createApiKeyAuth, createRateLimiter, createSecureResolver, RateLimitError
```

## 유지보수 (drift 방지)

- 이 README = 목적·개념·레시피만. API 정본은 소스 TSDoc.
- 새 export가 생기면 `src/index.ts` 상단 맵/이 표에 한 줄만 추가.

## Tests

```bash
cd platform/gateway && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
