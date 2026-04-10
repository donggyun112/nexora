# Nexora 데이터 흐름

---

## 1. 외부 요청 → 에이전트 실행

```
[사용자]
   │
   │ "로그인 버그 수정해줘" (Discord)
   │
   ▼
[Discord Adapter] ──── 메시지 정규화 ────▶ InboundMessage
   │
   ▼
[Gateway]
   ├── 인증 (Bearer token, timing-safe)
   ├── 테넌트 해석 (tenantId)
   ├── Intent 분류 (LLM haiku 또는 explicit 라우팅)
   └── topic 결정 → "task.bug-fix.requested"
   │
   ▼
[Transport] ──── publish ────▶ MessageEnvelope {
   │                            topic: "task.bug-fix.requested",
   │                            payload: { prompt, images, history },
   │                            metadata: { tenantId, traceId, spanId }
   │                          }
   ▼
[에이전트 프로세스]
   ├── 구독 중인 topic 매칭 → 수신
   ├── ContextLoader → AgentContext 로딩
   ├── Architecture.loop() → 실행
   └── 결과를 topic으로 발행
   │
   ▼
[Transport] ──── 결과 전파 ────▶ Gateway ────▶ Adapter ────▶ [사용자]
```

---

## 2. 영속화 흐름

```
[에이전트 실행 중]
   │
   ├── 대화 메시지 ──────▶ ConversationStore.appendMessage()
   │                          └── store-json: agents/{name}/data/conversations/{id}.jsonl
   │
   ├── 도구 호출/결과 ──────▶ ToolContextStore.recordCall/recordResult()
   │                          └── store-json: agents/{name}/data/tool-context/{scope}/{turn}.jsonl
   │
   ├── Compaction ──────────▶ ConversationStore.saveCompaction()
   │                          └── store-json: agents/{name}/data/conversations/{id}-summary.md
   │
   ├── 지식 업데이트 ────────▶ KnowledgeStore.write()
   │                          └── store-json: agents/{name}/data/knowledge/{topic}.md
   │
   ├── 스케줄 등록 ──────────▶ ScheduleStore.save()
   │                          └── store-json: agents/{name}/data/schedules.json
   │
   ├── 감사 로그 ────────────▶ AuditStore.record()
   │                          └── store-json: agents/{name}/data/audit/{date}.jsonl
   │
   └── 일일 컨텍스트 ────────▶ ContextStore.saveDailyContext()
                               └── store-json: agents/{name}/data/daily/{date}.json
```

**핵심: 모든 영속화는 store 인터페이스를 통해서만. 에이전트별 격리된 경로.**

---

## 3. 멀티에이전트 워크플로우 데이터 흐름

```
[Orchestrator]
   │
   │ workflow "bug-fix" 시작
   │
   ├──── Step 1 ────▶ [Transport] ──publish──▶ "code.fix.requested"
   │                                              │
   │                                    [dev-agent] 수신
   │                                    ├── 코드 분석
   │                                    ├── 버그 수정
   │                                    └── 결과 발행 ──▶ "code.fix.completed"
   │                                              │
   │◀──── result ─────────────────────────────────┘
   │
   ├──── Step 2 ────▶ [Transport] ──publish──▶ "code.review.requested"
   │                     (Step 1 결과를 payload에 포함)
   │                                              │
   │                                    [reviewer-agent] 수신
   │                                    ├── 코드 리뷰
   │                                    └── 결과 발행
   │                                              │
   │◀──── result ─────────────────────────────────┘
   │
   │ (onFailure → goto Step 1 가능)
   │
   └──── Step 3 ────▶ ... (deploy)
```

**핵심:**
- 에이전트 간 직접 통신 없음
- 모든 데이터는 transport의 MessageEnvelope를 통해 전달
- Orchestrator가 Step 간 데이터 전달 중재
- 각 에이전트는 자기 store에만 접근

---

## 4. 분산 트레이싱

```
사용자 요청 (traceId: abc-123)
   │
   ├── Gateway (spanId: span-1, parentSpanId: null)
   │
   ├── Orchestrator (spanId: span-2, parentSpanId: span-1)
   │
   ├── dev-agent (spanId: span-3, parentSpanId: span-2)
   │     ├── LLM 호출 (spanId: span-3a)
   │     ├── github 도구 (spanId: span-3b)
   │     └── exec 도구 (spanId: span-3c)
   │
   ├── reviewer-agent (spanId: span-4, parentSpanId: span-2)
   │     └── LLM 호출 (spanId: span-4a)
   │
   └── deploy-agent (spanId: span-5, parentSpanId: span-2)

모든 MessageEnvelope에 traceId/spanId/parentSpanId 포함
→ Jaeger/Grafana Tempo에서 전체 흐름 시각화
```

---

## 5. 테넌트 데이터 격리

```
tenant-A/
  ├── agents/
  │   ├── dev-agent/data/      ← tenant-A의 dev-agent 데이터
  │   ├── pm-agent/data/       ← tenant-A의 pm-agent 데이터
  │   └── reviewer/data/
  └── config/                  ← tenant-A 설정 (도구, 모델, 제한)

tenant-B/
  ├── agents/
  │   ├── dev-agent/data/      ← tenant-B의 dev-agent 데이터 (A와 완전 격리)
  │   └── custom-agent/data/
  └── config/

공유되는 것: contracts 타입, core 런타임, tools 정의, architectures
공유되지 않는 것: 데이터, 설정, 시크릿, 컨텍스트
```
