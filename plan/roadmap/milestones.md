# 마일스톤

## v0 알파 (12주차)
**목표**: 1테넌트 1에이전트 end-to-end + Skills 자기학습 1주기

성공 기준 — [README.md](README.md) "성공 기준" 참조

## v0 베타 (16주차)
**목표**: 외부 친밀 사용자 3~5명 dogfooding

추가 조건:
- [ ] 5명 이상 동시 사용자 부하 테스트
- [ ] 24시간 무중단 운영 검증
- [ ] 멀티 에이전트 (3~5개) 카탈로그 운영
- [ ] 첫 외부 피드백 라운드 적용
- [ ] 보안 감사 1차 (외부 또는 내부 체크리스트)

## v1 GA (32주차)
**목표**: 첫 유료 프로덕션 고객

추가 조건:
- [ ] WorkOS 엔터프라이즈 기능 (SCIM, audit log export)
- [ ] BYOK (테넌트 자체 LLM 키) 완전 동작
- [ ] 백업 / 복구 / DR 절차 문서화
- [ ] SLA 99.9% 측정 가능한 운영 (90일 추적)
- [ ] 가격 / 빌링 통합 (Stripe 등)
- [ ] 고객 콘솔 UI (관리자 대시보드)
- [ ] OpenAPI / Postman 컬렉션
- [ ] SOC 2 Type I 준비 시작

## v1.x (52주차 ~)
**선택 트랙**:

### A. 카탈로그 확장
- 마켓플레이스 (테넌트 간 Skill 공유, 검토)
- 에이전트 템플릿 라이브러리

### B. 멀티 에이전트
- Nexora의 원래 IP인 conversation/deliberation 모듈 옵션 활성화
- 도메인이 적합한 경우만 (정책 자문, 의료 합의 등)

### C. 운영 강화
- 멀티 리전 (US + EU)
- DR 자동 failover
- 더 정밀한 metric/SLI

## v2 (12~18개월)
**Rust hot path 통합 (측정된 압력 시)**

후보 컴포넌트:
- WASM 도구 샌드박스 (Cloudflare 패턴)
- 게이트웨이 / rate limiter (수십만 RPS 시)
- 토큰 카운터 / budget gate hot loop
- MCP 프록시

각 컴포넌트는 별도 마이크로서비스, Go가 cgo/HTTP/gRPC로 호출.

## 안 할 일 (의도적 보류)

| 항목 | 보류 이유 |
|---|---|
| 자체 vector DB | pgvector로 v0/v1엔 충분 |
| 자체 LLM 호스팅 | 인프라 부담, 외부 provider로 충분 |
| 자체 샌드박스 인프라 | E2B/Modal가 함, v2+ 검토 |
| 풀 RBAC 시스템 (자체) | WorkOS Organizations로 충분 |
| 풀 워크플로 비주얼 빌더 | Temporal Web UI + YAML manifest로 충분 |
| 풀 채팅 UI | API만 제공, UI는 고객/파트너가 |
| 마켓플레이스 (v1까지) | 카탈로그 자체가 1순위 |
| 멀티에이전트 정체성 강조 | 산업 컨센서스 반대편 — 도메인 적합 시만 옵션 |
