# 로드맵

## 마일스톤

| 단계 | 기간 | 목표 |
|---|---|---|
| **v0 알파** | 12주 | 1 테넌트 + 1 에이전트 end-to-end, Skills 자기학습 1주기 동작 |
| **v0 베타** | 16주 | 외부 친밀 사용자 3~5명 dogfooding |
| **v1 GA** | 32주 | 첫 유료 프로덕션 고객. 모든 must-fill 갖춤 |
| **v1.x** | ~52주 | 다중 페르소나, deliberation 모듈 옵션, 카탈로그 마켓플레이스 검토 |
| **v2** | 12~18개월 | Rust hot path 컴포넌트, 멀티 리전, WASM 샌드박스 |

## 문서

- [12-week-plan.md](12-week-plan.md) — v0 알파까지 주별 일정
- [milestones.md](milestones.md) — v0/v1/v2 상세 마일스톤

## 성공 기준 (v0 알파 출시 조건)

- [ ] 1개 테넌트가 1개 에이전트를 end-to-end로 사용 가능 (HTTP → SSE → 응답)
- [ ] 멀티테넌트 격리 lint 룰 통과 + Testcontainers로 2테넌트 시나리오 검증
- [ ] pre-execution budget gate가 실제로 호출을 차단함 (테스트로 입증)
- [ ] Skill 자기학습 1주기 (자동생성 → eval → 휴먼 승인 → 활성화)가 끝까지 동작
- [ ] Temporal 워커 크래시 후 재개 검증 (chaos test)
- [ ] OTel trace + Langfuse + audit ledger 모두 동작
- [ ] `/livez /readyz /healthz` + 알람 동작
- [ ] 시크릿 envelope 암호화 + WorkOS auth 동작
