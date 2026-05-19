# 보안

## 위협 모델

| 위협 | 영향 | 대응 |
|---|---|---|
| 테넌트 데이터 cross-leakage | 매우 큼 | 컴파일 타임 lint + RLS + 통합 테스트 |
| LLM 도구 호출 자체가 위험한 행동 (rm -rf 등) | 큼 | E2B 샌드박스 격리 + tool allowlist |
| LLM 프롬프트 인젝션 | 중 | input guardrails + output redaction |
| API 키 / 시크릿 노출 | 매우 큼 | envelope 암호화 + KMS + 절대 로그 X |
| Runaway loop (비용 폭발) | 큼 | pre-execution budget gate |
| DDoS / abuse | 중 | Cloudflare + 앱 레벨 rate limit |
| SQL injection | 중 | parametrized query 강제 (pgx) |
| 의존성 취약점 | 중 | dependabot + 정기 audit |

## 인증

- **외부 사용자**: WorkOS (SSO + SCIM)
- **API 키 (M2M)**: WorkOS API Keys 또는 자체 발급 (HMAC + scope)
- **관리자 콘솔**: WorkOS + MFA 강제
- **내부 서비스 간**: 같은 클러스터 내부 통신, 외부 노출 X. 외부 노출 시 mTLS

## 인가 (RBAC)

```
Organization (WorkOS) ─ Tenant 1:1 매핑
   ├── Role: admin
   │     - 모든 tenant 자원 CRUD
   │     - audit 조회
   │     - 카탈로그 promote/rollback
   ├── Role: developer
   │     - 에이전트 / Skill 정의
   │     - run 결과 조회
   ├── Role: viewer
   │     - 읽기 전용
   └── Role: agent-runtime (service account)
         - 에이전트 실행만, 정의 CRUD X
```

매 핸들러에서 `auth.RequireRole(ctx, "admin")` 등으로 강제.

## 시크릿 관리

### 플랫폼 시크릿
- DB 비밀번호, LLM provider 키, Temporal API 키 등
- 저장: 클라우드 SM (AWS Secrets Manager / GCP Secret Manager / Doppler)
- 액세스: 컨테이너가 IAM role로 fetch
- 로테이션: 분기마다 자동 (워크플로) 또는 수동

### 테넌트 BYOK (Bring Your Own Key)
- 저장: Postgres `tenant_byok_secrets` 컬럼에 **envelope 암호화**
- 암호화: 평문 → DEK (per-tenant) → KMS-encrypted
- 복호화: 사용 직전에만, ctx scope, 로그 절대 X
- 로테이션: `BYOKRotationWorkflow`

### 코드 / 로그에 절대 들어가면 안 되는 것
```go
// 시크릿 컬럼은 String() / MarshalJSON 오버라이드해서 "***"만 출력
type Secret struct { value []byte }
func (s Secret) String() string { return "***" }
func (s Secret) MarshalJSON() ([]byte, error) { return []byte(`"***"`), nil }
```

## 데이터 격리

### 멀티테넌트
- 행 레벨 (Tier 3): `tenant_id` 컬럼 + lint 강제 + 통합 테스트
- v1+: Postgres RLS 추가
- 캐시 키: `tenant:{id}:...` prefix 필수

### Pod 격리 (k8s)
- 컨테이너는 같은 노드에 공존 OK (서로 신뢰)
- 외부 노출 컨테이너만 별도 (Cloudflare 뒤)
- NetworkPolicy로 DB/Temporal 접근 제한

### 코드 실행 격리
- 모든 코드 실행 = E2B 샌드박스 (격리된 VM)
- 자체 호스팅에서 실행 안 함
- 결과만 받음, 환경은 휘발

## 입력 검증

- HTTP 요청: jsonschema + validator
- LLM 출력: instructor-go가 schema 검증
- 도구 args: jsonschema 검증 + 정책 게이트
- Skill body: markdown 파서 + injection 패턴 검출

## 프롬프트 인젝션 대응

- input guardrails (PII redactor 등)
- output guardrails (응답에 시스템 프롬프트 노출 검출)
- 도구 호출은 항상 정책 게이트 통과
- 위험 도구 (코드 실행 등)는 별도 확인 단계

## 취약점 대응

- 의존성: `go mod` + dependabot + 주 1회 audit
- 컨테이너: trivy 스캔 in CI
- CVE 알람: GitHub Security Advisories
- 패치 정책: critical 24h, high 7d, medium 30d

## 감사 / 컴플라이언스

- WorkOS Audit Logs로 고객 노출
- 자체 `audit_*` 로 내부 운영
- 7년 보존 (cold storage 이동 후)
- GDPR/CCPA: 테넌트 삭제 시 PII redaction (audit는 보존)
- SOC 2 Type I: v1 GA 시점 시작

## 비밀번호 / API 키 노출 인시던트 대응

`runbook/secret-leak.md`:
1. 노출된 키 즉시 회수
2. 영향 범위 audit 분석 (어떤 호출이 그 키로 갔나)
3. 새 키 발급 + 로테이션
4. 영향받은 테넌트에 통지
5. 포스트모템 작성
