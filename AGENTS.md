# AGENTS.md — Nexora를 쓰는 코딩 에이전트용 진입점

이 저장소는 **Nexora**(멀티테넌트 TypeScript 에이전트 프레임워크)다. 코딩 에이전트가 소스를 다 읽지 않고도 패키지를 정확히 쓰도록 라우팅한다.

## 가장 먼저 알 것

- **설치 가능한 패키지 식별자는 `@dongkseo/*` 뿐.** (`@nexora` npm org는 아직 없음.) 문서에 `@nexora/x`가 보이면 `@dongkseo/x`로 읽어라 — 그대로 설치하면 실패한다.
- 브랜드/제품명은 "Nexora", CLI 명령어는 `nexora`(이건 정상).

## 어디서 무엇을 찾나

1. **"X를 하려면 어느 패키지?"** → [`docs/architecture/packages-map.md`](docs/architecture/packages-map.md) 의 capability 표.
2. **한 패키지 쓰는 법** → 그 패키지의 README: `packages/<name>/README.md` 또는 `platform/<name>/README.md`.
3. **정확한 타입/시그니처** → README 본문을 베끼지 말고 `ctx_read(path, mode="signatures")` (또는 `mode="map"`)로 소스에서 직접. 정본은 소스 TSDoc.
4. **전체 그림(의존 방향·계층 흐름)** → 같은 지도 문서의 그래프/흐름 섹션. 역방향 import 금지(모두 `contracts`로 수렴).

## 최소 시작(3 패키지)

```bash
pnpm add @dongkseo/contracts @dongkseo/core @dongkseo/transport
```
나머지는 필요할 때 지도 표를 보고 하나씩 추가.

## README 규약

모든 패키지 README는 동일 골격을 따른다: **무엇인가/아닌가 · 핵심 개념 · 사용 레시피 · API 표면 · 유지보수 · Tests**. 템플릿: [`docs/architecture/README-template.md`](docs/architecture/README-template.md).
