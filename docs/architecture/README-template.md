# 패키지 README 골격 템플릿 (정본)

모든 `packages/*`·`platform/*` README는 이 골격을 따른다. 에이전트가 슬롯 위치로 정보를 추출하므로 **섹션 제목·순서를 바꾸지 말 것**. 패키지 식별자는 `@dongkseo/*`.

```markdown
# @dongkseo/<pkg>

**Stability: <stable|advanced|experimental>** · `pnpm add @dongkseo/<pkg>`

> 이 파일은 에이전트(사람·LLM)가 소스를 열지 않고도 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면"의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가
- ✅ 담는 것: …
- ❌ 안 담는 것: … (→ 어느 패키지로 가야 하는지)
의존 방향: **<pkg> → …** 단방향.

## 핵심 개념
| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| … | … | … |

## 사용 레시피
(임포트 포함 실제 동작 코드. 가능하면 examples/ 경로 참조)

## API 표면 (소스 안 열고 타입만)
ctx_read(path="<...>/src/index.ts", mode="map")
ctx_read(path="<...>/src/<file>.ts", mode="signatures")

## 유지보수 (drift 방지)
- 이 README = 목적·개념·레시피만. API 정본은 소스 TSDoc.
- 새 export가 생기면 src/index.ts 상단 맵/이 표에 한 줄만 추가.

## Tests
\`\`\`bash
cd <path> && pnpm test
\`\`\`

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
```

## 불변식 (agent-consumability)
- 설치/임포트 식별자는 `@dongkseo/*` (copy-paste-safe).
- "무엇이 아닌가" + 의존 방향으로 잘못된 패키지 import를 막는다.
- 타입은 본문 복제 금지, `signatures` 포인터로.
- 레시피는 실재 export만 사용.
