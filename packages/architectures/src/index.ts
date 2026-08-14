/**
 * @dongkseo/architectures — 에이전트 사고·실행 루프(agent architecture) 구현.
 *
 * 섹션 맵 — 어떤 export 가 어느 파일에 사는지:
 *
 *   react          ./react         createReactArchitecture, ReactOptions
 *                                  → ReAct (Reasoning + Acting) 루프. 가장 일반적인 도구 호출 루프.
 *   loop helpers   ./loop-helpers  LoopCompactionOptions
 *                                  → 한 턴 내부 history 압축(컨텍스트 윈도우 프루닝) 옵션.
 *   registry       ./resolve       resolveArchitecture, isSupportedArchitecture, SUPPORTED_ARCHITECTURES,
 *                                  SupportedArchitecture, ArchitectureBuildContext
 *                                  → 카드의 `architecture` 문자열을 실제 factory 호출로 잇는 단일 dispatch table.
 *
 * 정확한 시그니처는 각 소스의 TSDoc / signatures 모드로 읽을 것. README §API 표면 참고.
 */

export { createReactArchitecture } from './react.js';
export type { ReactOptions } from './react.js';
export type { LoopCompactionOptions } from './loop-helpers.js';

export { resolveArchitecture, isSupportedArchitecture, SUPPORTED_ARCHITECTURES } from './resolve.js';
export type { SupportedArchitecture, ArchitectureBuildContext } from './resolve.js';
