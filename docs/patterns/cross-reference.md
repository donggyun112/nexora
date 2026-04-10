# 크로스 레퍼런스: 에이전트 프레임워크 패턴 비교

---

## 1. 에이전트 정의 패턴

| 프레임워크 | 방식 | 상태 관리 |
|-----------|------|-----------|
| Auto-Work-Flow | 역할별 persona.ts + toolset.ts | Agent 인스턴스 내부 (인메모리) |
| Claude Code | Tool + frontmatter + AgentTool.tsx | React State (Zustand 스타일) |
| Deep Agents | create_deep_agent() 선언적 호출 | LangGraph State (리듀서) |
| OpenClaw | ChannelPlugin 어댑터 | Gateway 세션 |
| Google ADK | Agent 선언적 청사진 | SessionService 외부 위임 |

**Nexora 결정:**
- Google ADK처럼 **선언적 청사진** (agent.config.ts)
- 상태는 **외부 store에 위임** (에이전트는 무상태)
- Deep Agents처럼 **미들웨어로 횡단 관심사 처리**

---

## 2. 도구 시스템

| 프레임워크 | 정의 방식 | 동적 필터링 | MCP |
|-----------|----------|------------|-----|
| Auto-Work-Flow | createXxxTool() 팩토리 | guild별 toolsetMode | ✗ |
| Claude Code | Tool 인터페이스 + 레지스트리 | 권한 + Feature Gate | ✓ (양방향) |
| Deep Agents | Middleware가 도구 주입 | filter_tools() per LLM call | ✗ |
| OpenClaw | Plugin Tool Factory | Hook (beforeToolCall) | ✓ (mcporter) |
| Google ADK | BaseTool + Function + OpenAPI | PluginManager | ✓ |

**Nexora 결정:**
- contracts에 **ToolDefinition 인터페이스** 정의
- tools 패키지에 **builtin 구현 + MCP 브릿지** (양방향)
- context에서 테넌트별 **도구 허용 목록** 관리
- agent.config.ts에서 **도구 이름으로 선언**, 런타임에 조립

---

## 3. 멀티에이전트 통신

| 프레임워크 | 방식 | 격리 수준 |
|-----------|------|-----------|
| Auto-Work-Flow | runSubAgent() 직접 호출 | 같은 프로세스, 별도 Agent 인스턴스 |
| Claude Code | AgentTool (fork/tmux/인프로세스) | 프로세스 포크 또는 worktree |
| Deep Agents | task 도구 → SubAgentMiddleware | 컨텍스트 격리 (상태 필터링) |
| OpenClaw | Gateway 라우팅 | 세션 격리 |
| Google ADK | sub_agents + A2A 프로토콜 | 계층적 + 원격 |

**Nexora 결정:**
- 에이전트는 **서로를 모른다** (직접 호출 금지)
- **topic 기반 pub/sub** (transport)
- 흐름 제어는 **orchestrator의 workflow 정의**만
- 물리적 **프로세스 격리** (독립 배포)

---

## 4. 컨텍스트 관리 / Compaction

| 프레임워크 | 방식 | 트리거 |
|-----------|------|--------|
| Auto-Work-Flow | LLM 요약 → replaceMessages | contextTokens > window - reserve |
| Claude Code | Compact 서비스 + Static/Dynamic 경계 | 자동 + 수동 |
| Deep Agents | TruncateArgs → Full Summarization | fraction 0.85 |
| Google ADK | Event Compaction | Runner 내부 |

**Nexora 결정:**
- 2단계 (Deep Agents): **경량 잘라내기 → LLM 요약**
- Claude Code처럼 **캐시 가능 영역 분리** (시스템 프롬프트)
- 압축 결과는 **store에 영속화** (Discord 종속 제거)

---

## 5. 영속화

| 프레임워크 | 대화 | 지식 | 설정 | 스케줄 |
|-----------|------|------|------|--------|
| Auto-Work-Flow | Discord 메시지 | .md 파일 | env + 코드 | JSON 파일 |
| Claude Code | 트랜스크립트 파일 | Claude.md | settings.json | Cron (agent_triggers) |
| Deep Agents | LangGraph State | AGENTS.md | create_deep_agent() 인자 | ✗ |
| OpenClaw | Gateway 세션 | Plugin Memory | JSON5 config | Gateway Cron |
| Google ADK | SessionService | MemoryService | Agent 선언 | ✗ |

**Nexora 결정:**
- **store 인터페이스**로 전부 추상화
- 구현체 교체 가능 (JSON → MongoDB → PostgreSQL)
- 에이전트별 **로컬 경로 강제** (agents/{name}/data/)
- 공유 상태 없음

---

## 6. 보안 패턴

| 프레임워크 | 도구 권한 | 인젝션 방어 | 실행 승인 |
|-----------|----------|------------|----------|
| Auto-Work-Flow | guild별 toolsetMode | `<user_content>` 태그 | exec blocklist + 소켓 승인 |
| Claude Code | 다계층 (Mode+Rules+ML+Hook) | Protected files | Bash 파싱 안전 |
| Deep Agents | HITL 인터럽트 | ✗ | interrupt_on 설정 |
| OpenClaw | 그룹별 도구 정책 | fetchWithSsrfGuard | Exec 승인 매니저 |
| Google ADK | CredentialService | ✗ | Callback |

**Nexora 결정:**
- 테넌트별 **도구 정책** (context에서 주입)
- transport 메시지에 **tenantId 필수** (격리 보장)
- 외부 콘텐츠 **untrusted 원칙** 유지

---

## 7. 진입점 / 어댑터

| 프레임워크 | 채널 | 추상화 수준 |
|-----------|------|------------|
| Auto-Work-Flow | Discord 전용 | 없음 (Discord = DB) |
| Claude Code | CLI (터미널) | 없음 (단일 진입점) |
| Deep Agents | 없음 (라이브러리) | N/A |
| OpenClaw | 11개 채널 | ChannelPlugin 어댑터 |
| Google ADK | HTTP/gRPC/CLI | Runner가 프로토콜 무관 |

**Nexora 결정:**
- OpenClaw처럼 **어댑터 패턴**
- 어댑터는 **메시지 정규화만** (InboundMessage → Gateway)
- Gateway가 **테넌트 해석 + 라우팅**

---

## 8. 메모리 시스템

| 프레임워크 | 방식 | 장기 기억 |
|-----------|------|-----------|
| Auto-Work-Flow | knowledge .md + pm-memory 스레드 | Discord 스레드 (영구) |
| Claude Code | Claude.md + AutoDream | 백그라운드 통합 에이전트 |
| Deep Agents | AGENTS.md + Skills | 에이전트가 edit_file로 직접 수정 |
| OpenClaw | Plugin Memory (1개만) | 벡터 DB 등 플러그인 |
| Super-Memory | N:M 그래프 + Depth | 연관 회상 + 시간 감쇠 |

**Nexora 결정:**
- store의 **KnowledgeStore** 인터페이스
- Super-Memory의 **연관 회상** 개념 고려 (향후)
- Claude Code의 **AutoDream** 패턴 고려 (백그라운드 지식 통합)
- 에이전트별 **격리된 지식 공간**
