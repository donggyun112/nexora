# 배포

## 환경

| 환경 | 목적 | 인프라 |
|---|---|---|
| **dev** | 로컬 개발 | Testcontainers (Postgres/Redis/Temporal devserver) |
| **ci** | PR 테스트 | GitHub Actions + Testcontainers |
| **staging** | 통합 검증, 외부 사용자 일부 | 프로덕션 미니어처 |
| **production** | 실 사용자 | 멀티 AZ, v1+에서 멀티 리전 |

## 이미지

```dockerfile
# Dockerfile (Go 빌드, distroless 이미지)
FROM golang:1.24 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /api ./cmd/api
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /worker ./cmd/worker

FROM gcr.io/distroless/static-debian12
COPY --from=build /api /worker /
EXPOSE 8080
ENTRYPOINT ["/api"]
```

또는 `ko` (Go 친화 빌드):
```bash
ko build ./cmd/api --bare --platform=linux/amd64,linux/arm64
```

## 배포 패턴

### v0 (Fly.io 또는 Railway)
- 컨테이너 3~5개:
  - `api` (chi 서버) × 2~3
  - `worker` (Temporal 워커) × 2
  - `python-eval` × 1
- 관리형 Postgres / Redis / Temporal Cloud
- Cloudflare 앞단

### v1+ (k8s)
- 관리형 K8s (EKS/GKE)
- Deployment per 컴포넌트, HPA로 스케일
- Helm charts 또는 kustomize
- ArgoCD GitOps

## CI/CD

`.github/workflows/main.yml`:
```yaml
on: [pull_request, push]
jobs:
  test:
    runs:
      - actions/setup-go@v5
      - golangci-lint run
      - go test ./... -race -cover (with Testcontainers)
      - trivy fs .
  
  build-images:
    if: github.ref == 'refs/heads/main'
    runs:
      - ko build ./cmd/api
      - ko build ./cmd/worker
      - push to GHCR
  
  deploy-staging:
    needs: build-images
    runs:
      - flyctl deploy --image $IMAGE
      - smoke test
  
  deploy-production:
    needs: deploy-staging
    if: manual approval
    runs:
      - flyctl deploy --image $IMAGE
```

## 마이그레이션

- `goose` 으로 관리
- CI에서 마이그레이션 dry-run
- 배포 시 자동 적용 (단 large migration은 수동 게이트)
- 항상 backward-compatible (rolling deploy 안전)

## 워크플로 버저닝

Temporal 워크플로 코드 변경 시:
```go
v := workflow.GetVersion(ctx, "feature-x", workflow.DefaultVersion, 1)
```
진행 중 워크플로는 옛 코드 유지, 신규는 새 코드.

배포 절차:
1. 새 버전 코드 + GetVersion 가드
2. 워커 롤링 업데이트
3. 진행 중 워크플로 완료 대기 (7일 후 가드 제거 안전)

## 롤백

### 코드 롤백
```
flyctl deploy --image ghcr.io/.../api:<previous-tag>
```
- 이전 이미지로 즉시 전환
- 데이터 마이그레이션이 backward-compatible이면 무손실

### 카탈로그 롤백 (에이전트/Skill)
```
POST /v1/agents/{id}/rollback
```
`tenant_agent_grants.version` = `previous_version` 으로 스왑.

### 워크플로 롤백 (실행 중)
- 새 시그널 `rollback` 보내서 정리 단계 트리거
- 강제 종료 시 `temporal workflow terminate`

## 시크릿 회전

- 매월 자동 (cron 워크플로)
- 회전 절차:
  1. 클라우드 SM에 새 secret 작성
  2. 컨테이너 재시작 (rolling, 진행 중 요청은 graceful drain)
  3. 이전 secret 비활성화
  4. audit 로그 기록

## 백업 / 복구

| 자원 | 백업 | 복구 시간 목표 (RTO) |
|---|---|---|
| Postgres | PITR (관리형) + 일 full | 15분 |
| R2 (Skills 아티팩트) | 버전드 버킷, 자동 | 1분 |
| Temporal | 관리형 자동 백업 | 30분 |
| Redis | 백업 안 함 (휘발) | 즉시 (재구축) |

## DR (Disaster Recovery)

v0: 단일 리전, 백업 기반 복구
v1+: 멀티 AZ 자동 failover
v2+: 멀티 리전 active-active

DR drill: 분기 1회 staging에서 전체 복구 시뮬레이션.

## 옵저버빌리티 alerting 통합

배포 직후 5분간:
- 에러율 > baseline +20% → 자동 롤백
- 응답시간 p99 > baseline +50% → 알람
- Workflow 실패율 > 1% → 알람

이게 카탈로그 카나리 메트릭과 별개. 인프라 배포 자체의 안정성.
