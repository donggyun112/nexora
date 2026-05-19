# 인프라

## 저장소

### Postgres (주 저장소)

| 항목 | 결정 |
|---|---|
| 제공자 | Neon / Supabase (관리형) v0 → 자체 호스팅 v1+ |
| 드라이버 | `jackc/pgx/v5` |
| 마이그레이션 | `pressly/goose/v3` |
| 멀티테넌트 | 행 레벨 (`tenant_id` 컬럼). RLS는 v1+ 검토 |
| 백업 | Point-in-time recovery 활성 |
| 벡터 | `pgvector` 확장 (별도 vector DB 안 씀) |

### Redis

| 항목 | 결정 |
|---|---|
| 제공자 | Upstash (관리형, 서버리스) |
| 드라이버 | `redis/go-redis/v9` |
| 용도 | 캐시, ephemeral 코디네이션, rate limit 카운터 |
| **금지** | 영속 작업 큐 (Temporal이 소유) |

### Cloudflare R2

- Skill 아티팩트 / SKILL.md / 큰 blob
- Egress 무료 = 비용 우위
- S3 호환 API → AWS SDK 사용

## Durable execution: Temporal

| 항목 | 결정 |
|---|---|
| 제공자 | Temporal Cloud (v0 권장) — v1+ 자체 호스팅 검토 |
| SDK | `temporalio/sdk-go` |
| Task queue | `agent-runs`, `eval-runs`, `onboarding`, `catalog` |
| 워커 풀 | k8s deployment, HPA로 큐 깊이 기반 스케일 |

## 인증 / 인가

| 항목 | 결정 |
|---|---|
| B2B 인증 | WorkOS (SSO + SCIM + Org + Audit) |
| SDK | `workos/workos-go` **v7** (최신 stable) |
| 세션 토큰 | WorkOS 토큰 + 짧은 자체 JWT (선택) |
| RBAC | WorkOS Organizations + 자체 권한 매핑 |

## 관찰성

| 신호 | 도구 |
|---|---|
| LLM trace, prompt version | **Langfuse** (셀프호스트, REST 래퍼 자작) |
| 분산 trace, metrics, logs | **OpenTelemetry** + Collector → Tempo (또는 Honeycomb) |
| 구조화 로그 | `log/slog` JSON → Loki 또는 Cloud Logging |
| 에러 추적 | Sentry (옵션) |
| 알람 | Grafana Alerting 또는 Datadog |

## 엣지

| 항목 | 결정 |
|---|---|
| CDN / DDoS / WAF | Cloudflare |
| 엣지 rate limit | Cloudflare (거친 abuse만) |
| Geo routing | Cloudflare Argo (v1+) |
| **앱 레벨 rate limit** | **Redis 백드 자체 구현** — 테넌트별 정밀 제어 |

## 샌드박스 (코드/도구 실행)

| 항목 | 결정 |
|---|---|
| v0 | **E2B HTTP API 직접 호출** (~200 LOC Go 래퍼) |
| v1 옵션 | Modal Go SDK GA 되면 검토 |
| 자체 호스팅 옵션 | Firecracker (Cloudflare Sandboxes 패턴) — v2+ |

## 시크릿

| 항목 | 결정 |
|---|---|
| 플랫폼 시크릿 (DB 비번 등) | 클라우드 SM (AWS Secrets Manager / GCP Secret Manager / Doppler) |
| 테넌트 자체 자격증명 (BYOK) | **Postgres에 envelope 암호화 저장** (DEK는 KMS) |
| 로테이션 | 환경 변수 reload + 워커 재시작 (Temporal 무중단 보장) |

## 배포

| 항목 | v0 | v1+ |
|---|---|---|
| 컨테이너 런타임 | Fly.io 또는 Railway | K8s (관리형 EKS/GKE) |
| 이미지 빌드 | ko (Go 친화) 또는 buildkit | 동일 |
| CI/CD | GitHub Actions | 동일 + ArgoCD |
| 인프라 IaC | terraform 또는 pulumi | 동일 |

## 환경

- **dev**: 로컬 + Testcontainers
- **staging**: 프로덕션 미니어처
- **production**: 멀티 리전 (v1+)

## 비용 추정 (v0, 작은 트래픽)

| 항목 | 월 비용 |
|---|---|
| Temporal Cloud (entry) | ~$200 |
| Neon Postgres | ~$20 |
| Upstash Redis | ~$10 |
| Cloudflare (Pro) | $20 |
| WorkOS (Startup tier) | $0 (1k MAU까지) |
| Langfuse 셀프호스트 | 컨테이너 비용만 |
| Fly.io 컨테이너 3~5개 | ~$50 |
| **합계** | **~$300/월** |

v1+ 트래픽 증가 시 Temporal/Postgres 비용이 주요 증가 요인.
