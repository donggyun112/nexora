# ADR-004: 해자는 tenancy가 아니라 위임-감쇄 authority

**상태**: Accepted (프레임워크 측 구현 완료, 2026-07-28)
**날짜**: 2026-07-28
**범위**: `@dongkseo/tools`, `@dongkseo/contracts` — 그리고 README/포지셔닝
**관련**: [ADR-001](adr-001-tenancy-opt-in.md)(tenancy opt-in), [ADR-003](adr-003-isolation-is-commodity-not-moat.md)(격리=commodity)
**커밋**: `53acfc2`(decider lift + attenuation invariant), `7f58485`(delegate 전파)

---

## 컨텍스트

Nexora는 스스로를 "**Multi-tenant** agent framework"로 헤드라인해 왔다. 그러나 조사 결과
멀티테넌시는 **강제되는 격리 불변식이 아니라 스코핑 규약**이다:

- store는 `tenantId`를 모른다 — `namespace: string`만 받는다(`store-pg` 메서드 시그니처).
  "테넌트 격리"는 호출자가 `tenantId:agentName` 문자열을 올바르게 조립한다는 **규약**이지,
  구조적으로 교차 접근을 막는 **불변식(fail-closed)**이 아니다.
- ADR-001은 이미 tenancy를 opt-in으로 강등했다("90%가 안 쓰는 기능에 내는 세금").
- ADR-003은 **격리 자체는 commodity**라고 결론냈다(gVisor는 기본 티어).

두 결정이 합쳐지면 헤드라인이 무너진다: **격리가 commodity이고 tenancy가 opt-in이면,
"multi-tenant"는 정체성이 될 수 없다.** 그러면 프레임워크 레이어에 둘 가치가 있는,
차별화된 것은 무엇인가?

### 관찰 — 이미 있던 조각들

- 프레임워크는 이미 **승인 게이트 메커니즘**을 소유한다: contracts의 선언 seam
  (`ToolDefinition.policyGroups`/`permissionGroups`, "runtimes decide skip/ask/block/deny"),
  `@dongkseo/tools`의 `createApprovalGateMiddleware` + `resolveGroupAction` 리졸버 seam,
  그리고 delegate가 이미 게이트에 연결됨.
- **decider**(group `<domain>.<action>` → severity-join + 계층 merge)만 제품 런타임에 있었다.
- 위임은 depth 가드 + 정적 tool 차단리스트만 있고 **authority 감쇄가 전혀 없었다** —
  자식이 부모가 가진 적 없는 권한 그룹을 declare/보유할 수 있었다. `permissionGroups`는
  이름만 있고 `policyGroups`의 별칭(union)에 불과한 빈 축이었다.

## 결정

**해자는 격리 기술도 tenancy도 아니라, 에이전트 고유의 어려운 문제인 "위임 시 authority
감쇄(no-escalation)"다.** 프레임워크는 3층 authority 모델을 소유한다:

```
approval gate (정책층)   ← 에이전트가 "시도해도 되는가" — 조합형 skip/ask/block/deny  [소프트웨어]
    ⬇
authority attenuation (권한층) ← 위임 시 자식 grant ⊆ 부모 grant, 에스컬레이션 경로 없음   [소프트웨어]
    ⬇
gVisor (강제층)          ← 에이전트가 "물리적으로 못 하는" 것                          [커널]
```

세 층 중 두 개(정책·권한)를 이번에 프레임워크 측에서 구현·검증했다:

- **정책층**: 제품 런타임의 group decider를 `@dongkseo/tools/handraise/approval-policy.ts`로
  승격(fs/yaml/zod-free; `decide`/`mergeRules`/`createGroupPolicyResolver`). YAML 로더는
  제품에 남긴다 — ADR-001의 "core는 메커니즘, 소스는 주입/opt-in" 원칙과 동형.
- **권한층**: `authority.ts` — `attenuate(parent, requested)`(자식은 항상 부모의 부분집합) +
  `createEscalationGuard(inherited)`(상속 밖 그룹을 게이트에서 `deny`). `permissionGroups`에
  "위임 시 감쇄하는 authority" 실의미 부여. delegate가 매 hop에서 `inheritedAuthority`를 전파.
- **강제 증명**: 킬러 테스트 — 부모 grant `{A}` → 그룹 `B` 선언 도구 → 실제 게이트에서
  **DENIED, 실행 안 됨**(end-to-end).

### consumer 배선은 앱 레이어 (의도적 경계)

core `bootstrap.ts`는 delegate 도구도 게이트도 만들지 않는다 — 앱의 `createRuntime`가 만든다
(기존 `currentDepth`-from-envelope 배선조차 실 호출부가 없다). 따라서 "앱이
`envelope.metadata.inheritedAuthority`를 읽어 `currentAuthority`로 넘기고
`createEscalationGuard`를 게이트에 합성"하는 것은 **앱 레이어 책임이지 프레임워크 변경이 아니다.**
프레임워크는 불변식·메커니즘·전파를 제공하고, 앱이 한 줄로 opt-in한다 — tenancy/게이트와 동일 패턴.

## 결과

- (+) 헤드라인이 정직해진다 — README를 "multi-tenant"에서 **조율형 멀티에이전트 런타임 +
  authority 봉쇄 + OS 격리**로 리드(이 ADR이 path A를 정당화).
- (+) 면접 질문 "왜 프레임워크에 있어야 하죠?"의 방어가 생긴다: authority 감쇄는 cross-cutting
  불변식이고 앱마다 재구현하면 새기 때문에 프레임워크가 fail-closed로 보장한다.
- (+) `permissionGroups`가 빈 별칭에서 실축으로. 이름은 이미 contracts에 예약돼 있었다.
- (−) tenancy 어휘는 코드에 잔존(opt-in 능력으로 유지, 정체성에서만 강등). 완전 제거(ADR-001
  옵션 B, tenant→scope)는 별도 결정.
- (−) authority 3층 중 강제층 consumer 배선은 앱 몫 — 프레임워크는 primitives + 증명까지.

## 참고

- primitives: `packages/tools/src/handraise/authority.ts`, `approval-policy.ts`
- 게이트 seam: `packages/tools/src/handraise/approval-middleware.ts` (`resolveGroupAction`)
- 전파: `packages/tools/src/builtin/delegate.ts` (`currentAuthority`/`authorityForChild`)
- 계약: `packages/contracts/src/tool.ts` (`policyGroups`/`permissionGroups`),
  `message.ts`/`transport.ts` (`inheritedAuthority`)
