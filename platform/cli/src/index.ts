/**
 * @nexora/cli — 프로그래매틱 API.
 *
 * CLI 진입점은 src/cli.ts (bin: nexora).
 * 다른 도구에서 스캐폴딩을 호출하고 싶다면 여기서 import.
 */

export { scaffoldAgent } from './scaffold.js';
export type { ScaffoldOptions, ScaffoldResult } from './scaffold.js';

export { runDev } from './dev.js';
export type { DevOptions } from './dev.js';

export { exportPackage, importPackage } from './portability.js';
export type { ExportOptions, ImportOptions } from './portability.js';

export { runDoctor, viewDlq, viewBudget, viewHandraises } from './ops.js';
export type {
  DoctorOptions,
  DoctorResult,
  DoctorCheck,
  DlqViewOptions,
  DlqEntry,
  BudgetViewOptions,
  BudgetSummary,
  HandraiseViewOptions,
  HandraiseEntry,
} from './ops.js';
