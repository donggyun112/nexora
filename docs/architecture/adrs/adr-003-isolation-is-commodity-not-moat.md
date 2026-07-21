# ADR-003: 격리(sandbox)는 해자가 아니라 commodity — 해자는 그 위/옆에 있다

**상태**: Accepted (2026-07-21) — gVisor 백엔드를 실제 구현하고 runsc에서 end-to-end 검증하며 확정.
**날짜**: 2026-07-21
**범위**: [ADR-002](adr-002-single-agent-runtime.md)의 "격리 = 방어 가능한 해자" 근거 정정; `@dongkseo/sandbox-server`.

> [ADR-002](adr-002-single-agent-runtime.md)는 정체성을 "단일 에이전트 런타임"으로 좁히며,
> 엔지니어링 해자를 "런타임 -ility(격리·context·budget·durability·tracing)"로 들고, 근거에서
> **"남들은 실행 격리(sandbox)를 회피하는데 Nexora가 제일 깊게 판 게 하필 거기 — 방어 가능한 해자"**
> 라고 못 박았다. 이 ADR은 그 중 **격리(sandbox) 항목만** 정정한다. ADR-002의 나머지(정체성·ReAct
> 강화·다른 -ility)는 유효하다.

---

## 컨텍스트

gVisor 기반 격리 백엔드(`GvisorSandboxClient`)를 조사·설계·구현하면서 "격리 = 해자" 전제를 1차 자료로 재검토했다.

## 관찰 (사실로 확인)

- **격리 커널은 전부 commodity다.** gVisor(runsc, systrap 플랫폼 = KVM 불필요), Kata, Firecracker, Cloud Hypervisor — 오픈소스이고 `apt install runsc` 수준이다. 스파이크로 privileged 컨테이너 안 nested `runsc run`이 KVM 없이 부팅됨을 확인했다.
- **Nexora가 "제일 깊게 판" 격리는 사실 약한 티어였다.** 출하된 `OverlayRootfsSandboxClient`(bwrap)는 네임스페이스+cap-drop, **호스트 커널 공유** — 컨테이너와 같은 급이다. 적대적(신뢰 불가) 에이전트 코드에 대해 **경계가 아니라 위생(hygiene)**이다("containers don't contain").
- **진짜 경계는 사서 물리면 된다.** 우리가 한 것은 gVisor 커널을 기존 `createSandboxServer` seam에 얇게 물린 것(`GvisorSandboxClient` = raw `runsc run` + 이미지 rootfs/`--overlay2=none` + `--host-uds` socat 브리지). **발명이 아니라 통합**이다.
- **세션 lifecycle마저 commodity가 커버한다.** persist/hydrate/snapshot-fork는 gVisor `checkpoint`/`restore` + kubernetes-sigs/agent-sandbox(warm pool·hibernation)가 이미 제공한다.
- **결정적 반증**: gVisor 공식 블로그 [MAGI(Multi-Agent gVisor Isolation, 2026-04)](https://gvisor.dev/blog/2026/04/15/magi-multi-agent-gvisor-isolation/)가 멀티에이전트 격리에서 **"정책엔진·크리덴셜을 코어 샌드박스 밖에 두고 egress 시점에 주입"**을 권고한다 — Nexora의 auth-injecting gateway(OAuth 토큰이 잽 안에 절대 안 들어가고 대화별 in-memory 게이트웨이에만 존재; `@dongkseo/sandbox-server` `auth-gateway.ts` / agent-sandbox `jail-run.ts`)와 **동일 패턴**이다. 차별점이라 믿은 것조차 업계가 독립적으로 수렴한 표준이다.

## 결정

1. **"격리 = 해자" 주장 철회.** 격리 커널은 **commodity buy**다: gVisor를 기본 티어(어디서든, KVM 불필요)로, KVM 되는 호스트에서 Kata/Firecracker로 하드웨어 업그레이드. 격리 커널 자체를 새로 만들지 않는다.
2. **해자는 격리 기술이 아니라 그 위/옆에 있다** — 없으면 태만인 table-stakes와, 실제 차별점을 구분한다:
   - ADR-002가 이미 든 **나머지 런타임 -ility**: context 관리(compaction·retrieval)·budget·durability(checkpoint/resume)·tracing + ReAct 코어(hooks/goal).
   - **auth-injecting gateway**(크리덴셜 잽 밖·egress 주입) · **egress allowlist** · **nexora wire 계약 + per-conversation 세션 lifecycle 통합**.
   - 격리는 이 통합의 한 부품이지, 그 자체가 방어선은 아니다.
3. **bwrap 백엔드는 개발/기본 티어로 강등**하고 "이건 보안 경계가 아니라 위생"임을 문서에 명시한다. `GvisorSandboxClient`가 위협 모델(신뢰 불가 코드)에 대한 **첫 진짜 경계**다.

## 결과

- (+) **정직성** — 리뷰어가 몇 분 만에 반증할 "격리가 해자" 라인을 회수한다(ADR-002의 정직성 원칙과 일치).
- (+) **투자 재배치** — 격리 커널 자체 개발(raw Firecracker harness, Python wire 서버 재구현)을 중단하고 buy. 노력을 -ility·gateway·계약·통합으로 돌린다.
- (+) 별도 레포 **`work/microvm-sandbox`(Firecracker/Python)는 park** — `createSandboxServer`(TS)를 다른 언어로 재구현한 중복이었다. 격리 커널은 seam 뒤에 꽂으면 되고, seam은 이미 `@dongkseo/sandbox-server`에 있다.
- (−) "우리가 제일 깊게 판 격리" 마케팅 라인 상실 — 대신 통합·런타임 -ility로 승부한다.

## 참고

- [ADR-002: 단일 에이전트 런타임](adr-002-single-agent-runtime.md) — 정정 대상(격리 항목만)
- 설계/구현: `docs/superpowers/specs/2026-07-20-gvisor-sandbox-backend-design.md`, `packages/sandbox-server/src/gvisor-client.ts`
- 외부: [gVisor MAGI](https://gvisor.dev/blog/2026/04/15/magi-multi-agent-gvisor-isolation/), [gVisor Platforms](https://gvisor.dev/docs/architecture_guide/platforms/)

Part of the [Nexora](../../../README.md) agent runtime.
