/**
 * @dongkseo/architectures — 사고 패턴.
 *
 * - react: ReAct (Reasoning + Acting) 루프
 * - plan-execute: PLAN phase(도구 게이팅으로 계획 강제) → EXECUTE phase. plan mode 공식화.
 */

export { createReactArchitecture } from './react.js';
export type { ReactOptions } from './react.js';
export type { LoopCompactionOptions } from './loop-helpers.js';
export { createPlanExecuteArchitecture } from './plan-execute.js';
export type { PlanExecuteOptions } from './plan-execute.js';
