/**
 * @nexora/architectures — 4가지 사고 패턴.
 *
 * - react: ReAct (Reasoning + Acting) 루프
 * - loop: 조건부 반복
 * - plan-execute: 계획 → 실행 → (선택)리계획
 * - deep-research: Plan → Research → Evaluate → Compose
 */

export { createReactArchitecture } from './react.js';
export type { ReactOptions } from './react.js';

export { createLoopArchitecture } from './loop.js';
export type { LoopOptions } from './loop.js';

export { createPlanExecuteArchitecture } from './plan-execute.js';
export type { PlanExecuteOptions } from './plan-execute.js';

export { createDeepResearchArchitecture } from './deep-research.js';
export type { DeepResearchOptions } from './deep-research.js';
