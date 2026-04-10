# Nexora 에이전트 생명주기

---

## 1. 에이전트 정의

```typescript
// agents/dev-agent/agent.config.ts
export default defineAgent({
  name: 'dev-agent',
  architecture: 'react',
  tools: ['github', 'jira', 'exec', 'read', 'grep'],
  persona: 'You are a senior developer. Execute silently, report results.',

  config: {
    model: 'claude-sonnet-4-6',
    thinkingLevel: 'low',
    maxExecutionMs: 20 * 60 * 1000,
    contextWindow: 200_000,
  },

  // 구독하는 topic (transport에서 수신)
  subscribes: ['code.fix.requested', 'code.review.requested'],

  // 발행하는 topic (transport로 발신)
  publishes: ['code.fix.completed', 'code.review.completed'],
})
```

**참고 원본:**
- Auto-Work-Flow roles/developer/persona.ts (역할 정의)
- Google ADK Agent() (선언적 청사진)
- Deep Agents create_deep_agent() (선언적 생성)

---

## 2. 에이전트 부팅

```
agents/dev-agent/index.ts (독립 프로세스)
  │
  ├── 1. agent.config.ts 로드
  │
  ├── 2. @nexora/core AgentRunner 초기화
  │     ├── LLMProvider 설정 (provider-fallback)
  │     ├── ToolExecutor 생성 (도구 조립)
  │     ├── MemoryProvider 생성 (store 연결)
  │     └── Middleware 파이프라인 조립
  │
  ├── 3. @nexora/context ContextLoader 초기화
  │     └── 테넌트별 시스템 프롬프트 캐시
  │
  ├── 4. @nexora/transport 연결
  │     ├── subscribes 토픽 구독
  │     └── AgentCard를 registry에 등록
  │
  └── 5. 메시지 수신 대기
```

**참고 원본:**
- Auto-Work-Flow server/index.ts (부팅 시퀀스)
- OpenClaw gateway/server-chat.ts (세션 관리)

---

## 3. 요청 처리 흐름

```
[외부 메시지 수신 (transport)]
    │
    ▼
MessageEnvelope 수신
    │
    ▼
ContextLoader.load(tenantId, agentName)
  → AgentContext (시스템 프롬프트 + 도구 목록 + 제한)
    │
    ▼
Middleware.beforeExecution(context, input)
  → 도구 필터링, 프롬프트 주입, 상태 로딩
    │
    ▼
Architecture.loop(runtimeServices, input)
  ┌─────────────────────────────────┐
  │ ReAct 루프 (예시)              │
  │                                │
  │ 1. LLM 호출 (시스템 프롬프트 + 히스토리 + 입력) │
  │ 2. 응답 파싱 (텍스트 / 도구 호출)     │
  │ 3. 도구 실행 (ToolExecutor, 병렬)    │
  │ 4. 결과를 히스토리에 추가           │
  │ 5. Compaction 체크               │
  │ 6. 종료 조건 확인 → 반복 또는 완료   │
  └─────────────────────────────────┘
    │
    ▼
Middleware.afterExecution(context, result)
  → 결과 가공, 감사 로그, 메트릭
    │
    ▼
결과를 topic으로 발행 (transport)
```

**참고 원본:**
- Auto-Work-Flow runner.ts streamAgent() (이벤트 루프)
- Claude Code QueryEngine.ts (메시지 처리 파이프라인)
- Deep Agents graph.py (미들웨어 스택)
- Google ADK runners.py (Reason-Act 루프)

---

## 4. Compaction (컨텍스트 압축)

```
매 LLM 호출 전:
  tokens = estimateContextSize(messages)

  if tokens > contextWindow - reserveTokens:
    // 1단계: 경량 잘라내기 (Deep Agents TruncateArgs)
    truncateLargeToolResults(messages)

    // 2단계: 여전히 초과 시 LLM 요약 (Auto-Work-Flow compaction.ts)
    cutPoint = findCutPoint(messages, keepRecentTokens)
    summary = generateSummary(messages[0..cutPoint])
    messages = [summaryMessage, ...messages[cutPoint..]]

    // 요약 영속화 (store에 저장, Discord 아님!)
    store.saveCompaction(conversationId, summary)
```

**참고 원본:**
- Auto-Work-Flow compaction.ts (전체 로직)
- Deep Agents summarization.py (2단계 패턴)
- Claude Code compact/ (Static/Dynamic 경계)

---

## 5. Provider Fallback

```
providers = getAvailableProviders(preferredProvider)

for provider of providers:
  try:
    apiKey = await provider.getApiKey()  // pre-flight
    result = await executeWithProvider(provider, input)

    if result.isEmpty && hasNextProvider:
      continue  // 빈 응답도 실패로 간주

    return result
  catch:
    if hasNextProvider:
      log("${provider.name} 실패, ${next.name}으로 전환")
      continue
    throw
```

**참고 원본:**
- Auto-Work-Flow provider-fallback.ts (우선순위 기반)
- Auto-Work-Flow runner.ts (스트리밍 중 fallback)

---

## 6. 워크플로우 (멀티에이전트 협업)

```yaml
# workflows/bug-fix.yaml
name: bug-fix
trigger:
  type: topic
  topic: task.bug-fix.requested

steps:
  - id: analyze
    topic: code.fix.requested
    input: { type: fromTrigger }
    timeoutMs: 300000

  - id: review
    topic: code.review.requested
    input: { type: fromStep, stepId: analyze }
    onFailure: { action: goto, stepId: analyze }

  - id: deploy
    topic: deploy.requested
    input: { type: fromStep, stepId: review }
```

```
실행 흐름:

Orchestrator가 워크플로우 실행
  │
  ├── Step 1: topic "code.fix.requested" 발행
  │     └── dev-agent가 구독 중 → 수신 → 처리 → 결과 발행
  │
  ├── Step 2: topic "code.review.requested" 발행
  │     └── reviewer-agent가 구독 중 → 수신 → 처리
  │     └── onFailure: goto analyze → dev-agent 다시 실행
  │
  └── Step 3: topic "deploy.requested" 발행
        └── deploy-agent가 구독 중 → 수신 → 처리
```

**핵심:**
- 에이전트는 워크플로우를 모름
- 에이전트는 다른 에이전트를 모름
- topic만 알고, 자기 일만 함
- orchestrator만 전체 흐름을 알고 제어

**참고 원본:**
- Auto-Work-Flow scheduler/workflow-runner.ts (워크플로우 실행)
- Claude Code coordinator/coordinatorMode.ts (Coordinator+Workers)
- Google ADK SequentialAgent (순차 실행)

---

## 7. 에이전트 종료

```
graceful shutdown:
  1. transport 구독 해제
  2. 진행 중 작업 완료 대기 (타임아웃)
  3. registry에서 AgentCard 제거
  4. store 연결 종료
  5. 프로세스 종료
```

**참고 원본:**
- Auto-Work-Flow server/index.ts (SIGTERM/SIGINT 핸들링)
