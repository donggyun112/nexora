# 12주 v0 알파 일정

가정: 1~2인 풀타임. 매주 끝에 데모 가능한 결과물.

## Phase 1 — 토대 (Week 1-3)

### Week 1: 인프라 셋업 + Hello World
- [ ] Go 모노레포 초기화 (cmd/api, cmd/worker, internal/*)
- [ ] Postgres + Redis + Temporal devserver Testcontainers 구성
- [ ] chi 핸들러 1개 (`/healthz`), Temporal 워커 1개 (echo workflow)
- [ ] CI (GitHub Actions): build + test + lint
- [ ] slog + apperr + koanf 기본 wiring
- [ ] 첫 PR: 새 레포 초기 커밋

**데모**: curl localhost:8080/healthz가 OK 리턴, Temporal Web UI에서 echo workflow 실행 확인

### Week 2: 테넌트 + 인증 + 격리 기반
- [ ] WorkOS Go SDK 통합 (v7) — auth 미들웨어
- [ ] `tenant` 패키지 (context propagation, store)
- [ ] tenant resolve 미들웨어
- [ ] `db` 패키지 — tenant-aware Postgres 래퍼
- [ ] 첫 마이그레이션 (goose): tenants, tenant_limits
- [ ] golangci-lint custom rule: tenant_id 누락 검출 1차 버전

**데모**: 두 테넌트로 동일 엔드포인트 호출 → 격리 확인

### Week 3: 워크플로 + activity 기반
- [ ] Temporal worker 진입점 완성
- [ ] activity 패키지 구조 (`activities/llm.go`, `activities/audit.go`)
- [ ] `audit_runs` + `audit_turns` 테이블 + writer
- [ ] OTel + Langfuse 셀프호스트 셋업 (Docker compose)
- [ ] 더미 `AgentRunWorkflow` (LLM 없이 echo만)

**데모**: HTTP POST → workflow 시작 → audit 로그 생성

## Phase 2 — 코어 (Week 4-7)

### Week 4: LLM provider + agentkit 코어
- [ ] `llm` 패키지: Anthropic + OpenAI provider 인터페이스
- [ ] anthropic-sdk-go 통합 (Claude 4.7)
- [ ] openai-go 통합 (gpt-5.2)
- [ ] smart fallback (provider 에러 분류)
- [ ] `agentkit.Agent` 타입 + `agentkit.Run()` 시작

**데모**: Anthropic으로 단일 메시지 응답, 다운 시 OpenAI로 fallback

### Week 5: agentkit ReAct 전략
- [ ] `arch.ReAct` 전략 구현
- [ ] tool 인터페이스 + 함수 시그니처 → JSON Schema (reflection + instructor-go)
- [ ] 더미 tool 2개 (`echo`, `time_now`)
- [ ] history management
- [ ] max_turns 강제

**데모**: 에이전트가 echo 도구로 ReAct 루프 1회 완료

### Week 6: budget gate + tool 정책
- [ ] `budget` 패키지: Check + Charge
- [ ] Redis hot path + Postgres source of truth
- [ ] `BudgetCycleWorkflow` (cron, 일/월 리셋)
- [ ] tool 호출 정책 게이트 (allowlist + budget + audit)

**데모**: 한도 5센트 설정 → 호출 차단 입증

### Week 7: catalog + 카나리
- [ ] `catalog` 패키지: agent manifest CRUD
- [ ] `agents` + `tenant_agent_grants` 테이블
- [ ] SSE 스트리밍 응답 (run.started, llm.token, run.completed 이벤트)
- [ ] `/v1/agents/run` 엔드포인트 완성

**데모**: 카탈로그에서 에이전트 정의 → curl로 SSE 응답 수신

## Phase 3 — 차별점 (Week 8-10)

### Week 8: MCP + delegate + handraise
- [ ] modelcontextprotocol/go-sdk 통합
- [ ] MCP tool 등록 (외부 MCP 서버 1개 연동)
- [ ] `delegate` 도구 (child workflow)
- [ ] `HandraiseWorkflow` + handraise 도구
- [ ] handraise 응답 엔드포인트 (`POST /v1/handraises/{id}/respond`)

**데모**: 에이전트가 다른 에이전트로 위임 + 사람한테 escalate

### Week 9: Skills 라이프사이클
- [ ] `skills` 패키지: 자동 생성, eval 요청, 승인, 버전 핀
- [ ] `SkillAuthoringWorkflow` (휴먼 승인 시그널 대기)
- [ ] Python eval 사이드카 (FastAPI + Pydantic AI 기본)
- [ ] R2 통합 (SKILL.md 저장)
- [ ] `tenant_skill_states` 활성화/비활성화

**데모**: 에이전트가 Skill 제안 → 자동 eval → 관리자 승인 → 활성화 → 다음 호출에 반영

### Week 10: architecture pluggability + 카탈로그 롤아웃
- [ ] `arch.PlanExecute` 전략 추가
- [ ] manifest의 `architecture` 필드로 동적 선택
- [ ] `CatalogPromotionWorkflow` (카나리 5% → 50% → 100%)
- [ ] 메트릭 기반 자동 롤백

**데모**: 같은 에이전트의 ReAct vs Plan-Execute 버전 카나리 롤아웃

## Phase 4 — 운영 준비 (Week 11-12)

### Week 11: must-fill 7개 마무리
- [ ] `/v1/` 버전 prefix + 버전드 SSE 이벤트명
- [ ] Redis 백드 per-tenant rate limiter
- [ ] 시크릿 envelope 암호화 (KMS DEK)
- [ ] 클라우드 secret manager 통합
- [ ] `/livez /readyz /healthz` 완성
- [ ] OpenFeature 피처 플래그 (DB provider)

**데모**: rate limit 초과 시 429, 시크릿 회전 무중단

### Week 12: dogfooding + 알파 출시
- [ ] 자체 helpdesk 에이전트 1개를 새 스택 위에 구현
- [ ] chaos test: 워커 크래시 후 재개
- [ ] 부하 테스트 (k6, 100 RPS)
- [ ] 외부 친밀 사용자 1~2명 초청
- [ ] 알파 출시 발표

**데모**: 외부 사용자가 실제 사용

## 가드레일

- 매주 금요일 회고 — 다음 주 목표 재조정
- 위험 큰 항목은 Week 8 안에 들어가야 함 (시간 여유 위해)
- Week 11에 must-fill 마무리 못 하면 Week 12 dogfooding 축소
- agentkit scope creep 매주 점검

## 평행 작업 (전 기간)

- 문서: 각 컴포넌트의 README + ADR을 코드와 함께 작성
- 테스트: 매 PR마다 최소 1개 통합 테스트
- 데모 영상: 매주 1~2분 클립 보관 (회고용)
