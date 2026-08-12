# @dongkseo/tools

**Stability: stable** · `pnpm add @dongkseo/tools`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

에이전트가 실제로 호출하는 **도구(tool) 시스템** 패키지다. 기본 내장 도구들(read/grep/edit/exec/write …),
도구를 등록·필터·조립하는 레지스트리, 휴먼인더루프(handraise/승인) 프리미티브, 그리고 외부 MCP와의
양방향 브리지를 제공한다.

- ✅ 담는 것: 내장 도구 팩토리(`create*Tool`), `ToolRegistry`/프로파일·정책 조립, handraise/approval, MCP 브리지, reporter 미들웨어
- ❌ 안 담는 것: 도구 실행 루프(에이전트 런타임)·LLM 호출 — 그건 `core`/`architectures` 몫. 도구 결과 타입(`ToolDefinition`, `ToolResult`, `textResult` …)은 `contracts`가 정의

의존 방향은 **tools → contracts** 단방향. 도구는 `ToolDefinition`(contracts)을 만들어 내보내고, 실행은 다른 패키지가 한다. 스킬은 `@dongkseo/skills`의 `SkillTools`가 별도로 합성한다.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
|------|------|-------------|
| **내장 도구** | 즉시 쓰는 stock 도구 팩토리(파일 I/O·exec·검색·지식) | `createReadTool`, `createGrepTool`, `createEditTool`, `createWriteTool`, `createExecTool`, `createKnowledgeTool` |
| **웹/이미지** | 검색·페치 도구 + 백엔드 | `createWebSearchTool`, `createWebFetchTool`, `createBraveBackend`, `createImageSearchTool` |
| **에이전트 협업** | 위임·발행·HITL 도구 | `createDelegateTool`, `createHandraiseTool`, `createPublishTopicTool` |
| **레지스트리** | 도구 등록/필터/그룹·프로파일 조립 | `ToolRegistry`, `TOOL_GROUPS`, `TOOL_PROFILES`, `resolveToolNames`, `assembleToolsWithPolicy` |
| **Handraise (HITL)** | 사람에게 질문·승인 받는 프리미티브 | `HandraiseInbox`, `HandraisePolicy`, `InMemoryApprovalPolicyStore`, `createApprovalGateMiddleware` |
| **MCP 브리지** | 외부 MCP↔내부 도구 양방향 변환 | `mcpClientToTools`, `createMcpServerBridge` |
| **Reporter** | 도구 활동을 typed 이벤트로 발행 | `createReporterMiddleware`, `reportTopic` |

내장 도구 이름과 그룹: `group:fs`(read/write/edit/grep), `group:runtime`(exec), `group:web`(web-search/web-fetch),
`group:memory`(knowledge), `group:agent`(delegate/handraise), `group:skills`(skill).
프로파일: `minimal`(read/grep), `coding`(fs+runtime+memory+skills), `full`(제한 없음).

도구 실행 권한은 `ToolDefinition.policyGroups`/`permissionGroups`에 선언하고, 승인 게이트에서 채널별로
`skip | ask | block | deny`를 해석할 수 있다. 예: `['outline.write', 'requires_review', 'manager_only']`.

## 사용 레시피

도구를 만들어 에이전트별로 묶는다 (`examples/auto-work-flow` 기준, 실제 동작 코드):

```ts
import {
  createReadTool, createGrepTool, createEditTool,
  createWriteTool, createExecTool, createDelegateTool,
} from '@dongkseo/tools';

const baseTools = [createReadTool(), createGrepTool()];

const coderTools = [
  ...baseTools,
  createEditTool(), createExecTool(), createWriteTool(),
  createDelegateTool({ transport, registry, callerAgentName: 'coder' }),
];
```

레지스트리에 등록하고 카드/컨텍스트 기준으로 정책 조립 (`examples/helpdesk` 기준):

```ts
import { ToolRegistry, assembleToolsWithPolicy } from '@dongkseo/tools';

const registry = new ToolRegistry();
registry.registerAll([createReadTool(), createGrepTool()]);

// cardTools(에이전트 선언) + contextTools(런타임 컨텍스트)를 교집합/정책으로 필터
const { tools } = assembleToolsWithPolicy(registry, {
  cardTools: card.tools,         // 예: ['read', 'grep']
  contextTools: ctx.tools,
});
// → tools 를 실행기(core의 CoreToolExecutor 등)에 넘긴다
```

정책 그룹 기반 승인 게이트:

```ts
createApprovalGateMiddleware({
  transport,
  store,
  resolveGroupAction: ({ policyGroup, channel }) => {
    if (policyGroup === 'requires_review' && channel === 'multica') return 'skip';
    if (policyGroup === 'requires_review') return 'ask';
    if (policyGroup === 'destructive.delete') return 'block';
    return 'skip';
  },
});
```

더 큰 예제: [`examples/auto-work-flow`](../../examples/auto-work-flow) (PM→Coder→Reviewer + handraise),
[`examples/helpdesk`](../../examples/helpdesk) (레지스트리+정책 조립).

## API 표면 (소스 안 열고 타입만)

`index.ts`는 도메인별로 그룹핑돼 있고 파일 맨 위에 **섹션 맵 주석**이 있다. 정확한 시그니처가 필요하면
구현 본문 대신 **signatures 모드**로만 읽어라:

```
ctx_read(path="packages/tools/src/index.ts",            mode="map")         # 전체 export 목록
ctx_read(path="packages/tools/src/registry.ts",         mode="signatures")  # ToolRegistry / 정책
ctx_read(path="packages/tools/src/builtin/index.ts",    mode="map")         # 내장 도구 팩토리 목록
ctx_read(path="packages/tools/src/handraise/index.ts",  mode="map")         # HITL/승인
ctx_read(path="packages/tools/src/mcp/index.ts",        mode="map")         # MCP 브리지
```

어떤 파일에 뭐가 있는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/tools && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
