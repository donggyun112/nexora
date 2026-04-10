# Nexora 설계 결정 문서

---

## 확정된 원칙

1. **에이전트는 서로를 모른다** — contracts만 안다
2. **직접 호출 없다** — topic 기반 pub/sub만
3. **공유 상태 없다** — 에이전트별 로컬 데이터
4. **흐름 제어는 workflow에서만** — 에이전트 내부에서 위임 금지
5. **DB는 어댑터** — 진입점과 영속화 완전 분리
6. **프로세스 격리** — 에이전트별 독립 서버/컨테이너

---

## 패키지 구조 (확정)

```
nexora/
├── packages/
│   ├── contracts/          ← 공유 타입 (MessageEnvelope, Topic, AgentCard, WorkflowContract)
│   ├── core/               ← 에이전트 런타임 엔진
│   ├── tools/
│   │   ├── interfaces/     ← ToolDefinition
│   │   ├── builtin/        ← 자체 도구
│   │   └── mcp/            ← MCP client/server 브릿지
│   ├── architectures/      ← 사고 패턴 (ReAct, DeepResearch, PlanExecute)
│   ├── context/            ← 멀티테넌트 컨텍스트 주입
│   ├── transport/          ← topic 기반 pub/sub (이벤트 중심)
│   ├── store/              ← 영속화 인터페이스
│   ├── store-json/         ← JSON 파일 구현체
│   ├── orchestrator/       ← 선택적 워크플로우 엔진
│   └── adapters/           ← Discord, Slack, HTTP
│
├── agents/                 ← 조합된 에이전트 (각각 독립 배포, 로컬 data/)
├── workflows/              ← 워크플로우 정의
│
├── platform/
│   ├── gateway/            ← 라우팅 + 인증 + intent 분류
│   ├── registry/           ← AgentCard 기반 디스커버리
│   └── cli/                ← 스캐폴딩 (nexora create agent ...)
│
└── deploy/
```

---

## 레퍼런스별 차용 결정

### Auto-Work-Flow에서 차용
- [x] 역할 기반 페르소나 시스템 → context 패키지
- [x] 도구 팩토리 패턴 → tools/builtin
- [x] Compaction 로직 → core 런타임
- [x] Provider fallback → core LLMProvider
- [x] System prompt 조합 구조 → context 패키지
- [x] 스킬/지식 시스템 → store + context
- [ ] Discord 진입점 → adapters/discord (새로 구현)
- [x] deep-research 파이프라인 → architectures 패키지

### Claude Code에서 차용
- [x] Tool 레지스트리 (assemble → filter → merge) → tools 패키지
- [x] StreamingToolExecutor (병렬 실행) → core 런타임
- [x] Hook 이벤트 시스템 → core 미들웨어
- [x] MCP 양방향 브릿지 → tools/mcp
- [x] Static/Dynamic 프롬프트 경계 → context 캐싱
- [x] Coordinator + Workers 패턴 → orchestrator (workflow로 변환)
- [ ] AutoDream (백그라운드 지식 통합) → 향후 고려
- [ ] Feature gating → 에이전트별 도구 조합으로 대체

### Deep Agents에서 차용
- [x] Middleware 패턴 (도구 전/후 처리) → core 미들웨어
- [x] Backend 추상화 → store 인터페이스
- [x] CompositeBackend (경로별 라우팅) → 에이전트별 로컬 데이터
- [x] Summarization 2단계 (Truncate → Full) → core compaction
- [x] Skills SKILL.md 스펙 → context 스킬 로딩
- [x] 서브에이전트 3타입 (선언/빌드/비동기) → transport topic 위임

### OpenClaw에서 차용
- [x] Gateway 중앙 컨트롤 플레인 → platform/gateway
- [x] ChannelPlugin 어댑터 패턴 → adapters 패키지
- [x] Hook 수명주기 체인 → core 미들웨어
- [x] 세션 라우팅 → context 테넌트 해석
- [x] Plugin Registry → platform/registry

### Google ADK에서 차용
- [x] 선언적 Agent 청사진 → agent.config.ts
- [x] 무상태 Runner → core 런타임
- [x] 이벤트가 SOT → transport MessageEnvelope
- [x] 서비스 추상화 (Interface 기반) → store 인터페이스
- [x] 멀티에이전트 타입 (Loop/Parallel/Sequential) → architectures

### Super-Memory에서 차용
- [ ] 연관 회상 (2-hop 그래프) → 향후 store 확장
- [ ] Depth 시스템 (중요도 + 시간 감쇠) → 향후 knowledge 확장
- [x] Key 타입 분류 → 지식 네임스페이스 개념

---

## 주요 설계 결정 이유

### Q: 왜 A2A 프로토콜을 안 쓰나?
A: A2A는 에이전트 간 직접 RPC 통신이 전제. Nexora는 "에이전트는 서로를 모른다"가 원칙이라 topic pub/sub과 충돌. Agent Card 개념만 registry에 흡수.

### Q: MCP는 어디에?
A: tools/mcp에 양방향 브릿지.
- Client: 외부 MCP 서버를 ToolDefinition으로 변환
- Server: 내부 도구를 MCP 서버로 노출

### Q: 왜 orchestrator가 선택적인가?
A: 단순한 단일 에이전트 사용 시 orchestrator 불필요. 멀티에이전트 협업이 필요할 때만 workflow 정의로 활성화.

### Q: 왜 store를 인터페이스와 구현체로 분리하나?
A: Discord가 DB였던 문제 해결. 진입점 교체 시 데이터 소실 방지. JSON → MongoDB → PostgreSQL 교체 가능.

### Q: 에이전트별 로컬 데이터를 강제하는 이유?
A: 공유 JSON 금지로 에이전트 간 결합 제거. 각 에이전트가 자기 data/ 안에서만 영속화. 독립 배포의 전제 조건.
