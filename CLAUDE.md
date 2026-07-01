# CLAUDE.md — Nexora 진입점 (Claude / coding agents)

이 저장소는 **Nexora**(멀티테넌트 TypeScript 에이전트 프레임워크)다.
소스를 다 읽지 말고, 아래 라우팅을 먼저 타라.

## 먼저 읽을 것 (순서대로)

1. **[`AGENTS.md`](AGENTS.md)** — 에이전트용 진입점(규약·최소 시작·주의사항). **여기가 정본 라우터.**
2. **[`docs/architecture/packages-map.md`](docs/architecture/packages-map.md)** — "X를 하려면 어느 패키지?" capability 표 + 의존 방향 + 요청 흐름.
3. 한 패키지 쓰는 법 → `packages/<name>/README.md` 또는 `platform/<name>/README.md`.
4. 정확한 타입/시그니처 → README를 베끼지 말고 소스에서 직접: `ctx_read(path, mode="signatures")` (또는 `mode="map"`). 정본은 소스 TSDoc.

## 절대 틀리지 말 것

- **설치 가능한 패키지 식별자는 `@dongkseo/*` 뿐.** (`@nexora` npm org는 없음.) 문서에 `@nexora/x`가 보이면 `@dongkseo/x`로 읽어라 — 그대로 설치하면 실패한다.
- 브랜드/제품명은 "Nexora", CLI 명령어는 `nexora`(정상).
- 역방향 import 금지 — 모든 패키지는 `contracts`로 수렴한다.
