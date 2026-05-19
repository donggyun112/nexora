# 운영

| 문서 | 내용 |
|---|---|
| [observability.md](observability.md) | OTel + Langfuse + slog + 알람 |
| [security.md](security.md) | 인증·인가·시크릿·격리·취약점 대응 |
| [deployment.md](deployment.md) | 환경·CI/CD·배포·롤백 |

## 운영 안정성 4축

1. **관찰성**: 모든 trace 하나의 view에서 추적 가능
2. **격리**: 한 테넌트 사고가 다른 테넌트에 안 새어 들어감
3. **복구**: 워크플로 영속 + DB PITR + R2 버전드
4. **격리 가능성**: 인시던트 발생 시 빠른 차단 (kill switch, feature flag)

## v0 출시 전 must-have 체크리스트

- [ ] `/livez /readyz /healthz` 모두 동작
- [ ] OTel collector → Tempo → Grafana 한 흐름
- [ ] Langfuse 셀프호스트 + 모든 LLM 호출 trace
- [ ] `log/slog` JSON + request_id/tenant_id/run_id 자동 첨부
- [ ] 에러 → Sentry (옵션) 또는 자체 알람
- [ ] Slack/이메일 알람 라우팅
- [ ] 시크릿: 클라우드 SM + envelope 암호화
- [ ] WorkOS auth 미들웨어 모든 `/v1/*` 라우트
- [ ] Rate limit (Cloudflare + 앱 레벨)
- [ ] Postgres PITR 백업
- [ ] DR 절차 1페이지 (DB 복구 시간, R2 복원, Temporal 백업)
- [ ] runbook 3개 (LLM provider 다운, DB 장애, Temporal 장애)
