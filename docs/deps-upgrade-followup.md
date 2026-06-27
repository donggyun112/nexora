# 의존성 업그레이드 후속 대응 (TS6 / pi-ai 0.80)

> 작성: 2026-06-28 · 브랜치 `chore/deps-update` (commit `c6d73e3`, main 미머지)
> 커밋 시점 검증: `pnpm build` 25/25 · `pnpm test` 48/48 · `pnpm lint` 14/14 통과

major 의존성 업그레이드(typescript 5.9→6.0, @types/node 22→26, vite 6→8,
@vitejs/plugin-react 4→6, @earendil-works/pi-ai 0.79→0.80)를 적용하면서 생긴
**나중에 처리해야 할 항목**들.

## 1. (1순위) pi-ai `/compat` 제거 리스크

`packages/core/src/pi-models.ts`가 아직 `getEnvApiKey`를 `@earendil-works/pi-ai/compat`
에서 import 한다.

- `getEnvApiKey` 자체는 **deprecated 아님**. 하지만 pi-ai가 이 함수를 **다른 공개 경로로
  노출하지 않는다** — 패키지 `exports` 맵에 없고, root(`@earendil-works/pi-ai`)에서도
  re-export 안 함. 유일한 공개 진입점이 `/compat`.
- `/compat` 모듈 헤더는 *"Temporary compatibility entrypoint"* 로 명시되어 있음.
  pi-ai가 다음 major에서 compat 모듈을 삭제하면 **이 import가 깨진다.**

### 그때 대응안
- **(a)** 공개 sync API `listAvailableModels`를 async 로 바꾸고 `Models.getAuth()` 사용.
  → `platform/cli/src/headless.ts`가 이 함수를 **동기 호출**하므로 호출부까지 수정 필요(breaking).
- **(b)** pi-ai upstream에 `getEnvApiKey`(또는 동등 sync env-key 헬퍼) 공개 export 요청.

> 참고: core의 나머지 pi-ai 사용부는 이미 deprecated dispatch API에서 정식 API로 이전 완료.
> `packages/core/src/llm/pi-ai/provider.ts` → `builtinModels()` 컬렉션 + `models.streamSimple/completeSimple`,
> catalog 읽기 → `@earendil-works/pi-ai/providers/all`의 `getBuiltinProviders/getBuiltinModels`.

## 2. TypeScript 6 `types: ["node"]` 워크어라운드

TS6는 더 이상 `node_modules/@types/*`를 **자동 포함하지 않는다**. 그래서 `Buffer`,
`AbortSignal`, `setInterval` 등 node 글로벌이 전부 깨졌고, `tsconfig.base.json`에
`"types": ["node"]`를 명시적으로 추가해 해결했다.

영향:
- 이를 명시하니 `@types/node`를 직접 의존하지 않던 `packages/fleet`, `packages/store`가
  `TS2688`로 실패 → 두 패키지 devDependencies에 `@types/node` 추가함.
- **앞으로 새 패키지가 비-node ambient 타입(예: DOM, `vitest/globals` 타입 패키지)이
  필요하면, 해당 패키지 자체 tsconfig의 `types`에 직접 나열해야 한다.** base가 더 이상
  자동으로 끌어오지 않는다.

## 미해결 상태
- [ ] 브랜치 `chore/deps-update` main 머지 / 푸시 결정
- [ ] (pi-ai compat 제거 시점에) 위 1번 대응
