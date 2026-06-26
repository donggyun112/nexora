# Nexora 패키지 상세 스펙

---

## packages/contracts

**역할:** 모든 패키지가 공유하는 타입 계약. 에이전트는 서로를 몰라도 되고 계약만 알면 됨.

**내용:**
| 타입 | 출처 | 설명 |
|------|------|------|
| MessageEnvelope | auto-work-flow AgentStreamEvent + Google ADK Event | 에이전트 간 통신 단위 |
| TopicString | 신규 설계 | topic 주소 체계 + 와일드카드 매칭 |
| AgentCard | A2A Agent Card 차용 | 에이전트 능력 선언 (registry 등록용) |
| WorkflowContract | 신규 설계 | 워크플로우 단계 정의 |
| ToolDefinition | auto-work-flow AgentTool + Claude Code Tool | 도구 계약 |
| AgentRuntime | auto-work-flow runner + Google ADK Runner | 에이전트 실행 인터페이스 |
| AgentArchitecture | 신규 설계 | 사고 패턴 플러그인 |
| RuntimeServices | Claude Code QueryEngineConfig | 런타임 서비스 묶음 |
| LLMProvider | auto-work-flow client.ts + provider-fallback.ts | LLM 호출 추상화 |
| ConversationStore | auto-work-flow discord-history.ts 대체 | 대화 영속화 |
| KnowledgeStore | auto-work-flow knowledge.tool.ts 대체 | 지식 영속화 |
| ScheduleStore | auto-work-flow dynamic-job-store.ts 대체 | 스케줄 영속화 |
| ContextStore | auto-work-flow daily-context.ts 대체 | 컨텍스트 영속화 |
| AuditStore | auto-work-flow pm-memory.ts 대체 | 감사 로그 |
| ToolContextStore | auto-work-flow tool-context-store.ts 대체 | 도구 실행 기록 |
| AgentContext | auto-work-flow system-prompt.ts SystemPromptOptions | 텐넌트별 컨텍스트 |
| Adapter | OpenClaw ChannelPlugin 차용 | 진입점 어댑터 |
| Transport | 신규 설계 | pub/sub 통신 |

**의존성:** 없음 (순수 타입)

---

## packages/core

**역할:** 에이전트 런타임 엔진. 모든 에이전트가 공유하는 실행 인프라.

**참고:**
- auto-work-flow runner.ts (createAgent, streamAgent, runAgent)
- auto-work-flow compaction.ts (withCompaction)
- Claude Code QueryEngine.ts (실행 루프)
- Claude Code StreamingToolExecutor (병렬 도구 실행)
- Deep Agents graph.py (create_deep_agent)
- Google ADK runners.py (무상태 Runner)

**제공하는 것:**
| 기능 | 참고 원본 |
|------|-----------|
| AgentRunner | runner.ts streamAgent() + Google ADK Runner |
| ToolExecutor | Claude Code StreamingToolExecutor (병렬) |
| Compaction | compaction.ts 2단계 (Deep Agents Summarization) |
| MiddlewarePipeline | Deep Agents Middleware 패턴 |
| IdleTimeout | auto-work-flow idle-timeout.ts |
| ProviderFallback | auto-work-flow provider-fallback.ts |
| TokenEstimation | compaction.ts estimateTokens() |

**의존성:** @dongkseo/contracts

---

## packages/tools

**역할:** 도구 레지스트리 + MCP 브릿지 + builtin 도구.

**참고:**
- auto-work-flow tools/ (28개 도구, 팩토리 패턴)
- Claude Code tools.ts (레지스트리 + 필터링)
- Claude Code services/mcp/ (양방향 MCP)

**구조:**
```
tools/
├── interfaces/     ← ToolDefinition (contracts에서 re-export)
├── registry.ts     ← 도구 등록 + 필터 + 조립
├── builtin/        ← 포팅할 도구
│   ├── jira.ts
│   ├── github.ts
│   ├── mongo.ts
│   ├── web-search.ts
│   ├── exec.ts
│   ├── read.ts
│   ├── grep.ts
│   ├── knowledge.ts
│   ├── schedule.ts
│   └── ...
└── mcp/
    ├── client.ts   ← 외부 MCP 서버 → ToolDefinition 변환
    └── server.ts   ← 내부 도구 → MCP 서버 노출
```

**의존성:** @dongkseo/contracts

---

## packages/architectures

**역할:** 에이전트 사고 패턴 플러그인.

**참고:**
- auto-work-flow runner.ts (단일 Reason-Act 루프)
- auto-work-flow deep-research.ts (Plan→Research→Compose→Develop)
- Google ADK agents/ (LlmAgent, LoopAgent, ParallelAgent, SequentialAgent)

**패턴:**
| 이름 | 출처 | 설명 |
|------|------|------|
| react | runner.ts 기본 루프 | Thought → Action → Observation |

커스텀 아키텍처는 `AgentArchitecture` 인터페이스를 구현해 외부에서 정의 가능.

**의존성:** @dongkseo/contracts

---

## packages/context

**역할:** 테넌트/유저 컨텍스트 로더. 같은 에이전트도 컨텍스트에 따라 다르게 동작.

**참고:**
- auto-work-flow system-prompt.ts (buildSystemPrompt, company.md + persona + ops)
- auto-work-flow jira-guilds.ts (guild별 설정)
- Claude Code context.ts (시스템 컨텍스트 빌드)
- Deep Agents memory.py (AGENTS.md 로딩)

**제공하는 것:**
| 기능 | 참고 원본 |
|------|-----------|
| ContextLoader | system-prompt.ts buildSystemPrompt() |
| PersonaLoader | orca/personas/*.md |
| SkillLoader | orca/skills/*.md + Deep Agents skills.py |
| KnowledgeLoader | knowledge.tool.ts + AGENTS.md |
| TenantConfigResolver | jira-guilds.ts → DB 기반으로 전환 |

**의존성:** @dongkseo/contracts, @dongkseo/store

---

## packages/transport

**역할:** 에이전트 간 이벤트 통신. RPC 아님. topic/capability 기반 pub/sub만.

**참고:**
- auto-work-flow sub-agent.ts (직접 호출 → 이를 topic으로 전환)
- Claude Code coordinator/ (Coordinator+Workers → workflow로 전환)
- Google ADK A2A (원격 에이전트)

**제공하는 것:**
| 기능 | 설명 |
|------|------|
| LocalTransport | 로컬 개발용 EventEmitter |
| RedisTransport | 프로덕션용 Redis Pub/Sub |
| TopicMatcher | 와일드카드 패턴 매칭 |
| TracingMiddleware | traceId/spanId 자동 전파 |
| RequestReply | 단일 응답 대기 패턴 (topic 기반) |

**규칙:**
- 에이전트 이름 직접 호출 금지
- topic/capability 기반 publish/subscribe만 허용
- 모든 메시지에 tenantId 필수

**의존성:** @dongkseo/contracts

---

## packages/fleet

**Role:** Worker coordination layer that lets Nexora operate as an agent fleet control plane. External OpenClaw, Hermes, Claude Code, and personal agents register as Nexora workers, then Nexora selects workers by capability.

| Feature | Description |
|------|------|
| WorkerRegistry | Live worker registration, heartbeat, health, capability lookup |
| FleetCoordinator | Capability dispatch -> worker selection -> invocation -> oracle submit check |
| Broadcast | `announce`, `fanout`, `race`, and `quorum` fan-out modes |
| HttpWorkerInvoker | Calls external workers with HTTP endpoints |

**Rules:**
- Nexora does not start or stop worker processes.
- Workers request tool, memory, submit, and effect operations through the Nexora protocol boundary.
- Worker selection is based on capability, health, and load.
- Broadcast requests must carry broadcast identity, TTL, and idempotency metadata when side effects are possible.

---

## packages/store + packages/store-json

**역할:** 영속화 인터페이스 + JSON 파일 구현체.

**참고:**
- auto-work-flow discord-history.ts, daily-context.ts, pm-memory.ts, dynamic-job-store.ts, tool-context-store.ts, knowledge.tool.ts
- Deep Agents backends/ (StateBackend, FilesystemBackend, StoreBackend, CompositeBackend)

**store (인터페이스):**
- ConversationStore (discord-history 대체)
- KnowledgeStore (knowledge.tool.ts 대체)
- ScheduleStore (dynamic-job-store.ts 대체)
- ContextStore (daily-context.ts 대체)
- AuditStore (pm-memory.ts 대체)
- ToolContextStore (tool-context-store.ts 대체)

**store-json (구현체):**
- 에이전트별 로컬 경로 강제: agents/{agent}/data/
- 공유 JSON 금지

**의존성:** @dongkseo/contracts

---

## packages/orchestrator

**역할:** 선택적 워크플로우 엔진. 에이전트 간 흐름 제어.

**참고:**
- auto-work-flow scheduler/ (워크플로우 러너, 동적 작업)
- Claude Code coordinator/ (Coordinator+Workers 패턴)
- Google ADK ParallelAgent, SequentialAgent

**제공하는 것:**
| 기능 | 설명 |
|------|------|
| WorkflowEngine | WorkflowContract 실행기 |
| StepExecutor | topic 발행 + 결과 대기 |
| RetryPolicy | 재시도 + 백오프 |
| CronScheduler | 주기적 워크플로우 트리거 |

**규칙:**
- 에이전트 내부에서 다른 에이전트 직접 위임 금지
- 흐름은 workflow 정의로만 연결

**의존성:** @dongkseo/contracts, @dongkseo/transport

---

## packages/adapters

**역할:** 진입점 어댑터. 메시지 정규화만 담당.

**참고:**
- auto-work-flow integrations/discord/ (Discord 통합)
- OpenClaw ChannelPlugin (11개 채널 어댑터)

**어댑터:**
| 이름 | 출처 |
|------|------|
| DiscordAdapter | auto-work-flow discord/ 리팩터링 |
| SlackAdapter | OpenClaw slack/ 참고 |
| HttpAdapter | 신규 (REST API) |
| WebSocketAdapter | OpenClaw gateway/ 참고 |

**규칙:**
- 어댑터는 메시지 전달만 (DB 역할 금지)
- InboundMessage → Gateway → Agent

**의존성:** @dongkseo/contracts

---

## platform/gateway

**역할:** API Gateway. 라우팅, 인증, 테넌트 해석.

**참고:**
- auto-work-flow server/ (JSON-RPC, auth, session)
- OpenClaw gateway/ (WebSocket 컨트롤 플레인)
- Claude Code 권한 시스템

**제공하는 것:**
| 기능 | 참고 |
|------|------|
| TenantResolver | jira-guilds.ts → DB 기반 |
| IntentClassifier | LLM 기반 라우팅 (가벼운 모델) |
| AuthMiddleware | server/auth.ts (timing-safe) |
| RateLimiter | OpenClaw 참고 |

---

## platform/registry

**역할:** AgentCard 기반 디스커버리.

**참고:**
- A2A Agent Card 개념
- OpenClaw Plugin Registry

**제공하는 것:**
| 기능 | 설명 |
|------|------|
| AgentRegistry | AgentCard 등록/조회 |
| CapabilityMatcher | capability → 구독 에이전트 매칭 |
| HealthCheck | 에이전트 상태 모니터링 |

---

## platform/cli

**역할:** 에이전트 스캐폴딩 CLI.

```bash
npx nexora create agent qa-tester \
  --architecture react \
  --tools github,jira,exec
```

생성 결과:
```
agents/qa-tester/
├── agent.config.ts
├── package.json
├── Dockerfile
├── index.ts
└── data/          ← 로컬 영속화 디렉토리
```
