// ─── Orchestrator: 워크플로우 실행 + 스케줄러 ──────────────────────────────
//
// 섹션 맵 (에이전트용: 무엇이 어느 파일에 있는지 — 정확한 타입은 해당 파일을 signatures 모드로)
//   Workflow engine   ./engine                  WorkflowEngine (run/resume), *Options, *Result
//   Workflow runtime  ./workflow-runtime         createWorkflowRuntime (workflow → AgentRuntime)
//   Workflow agent    ./workflow-agent           bootstrapWorkflow + workflowCard (트리거 자동 연결)
//   State store       ./workflow-state-store     InMemoryWorkflowStateStore (체크포인트)
//   Suspended turn    ./suspended-turn-store     InMemorySuspendedTurnStore (중단 턴 보관)
//   Scheduler         ./cron                     CronScheduler, intervalJob, oneShotJob, CronJob
//
// 새 모듈을 export하면 여기 한 줄 추가. API 설명은 각 파일 TSDoc이 정본 — 위는 위치 안내만.

export { WorkflowEngine } from './engine.js';
export type {
  WorkflowEngineOptions,
  ProductionWorkflowEngineOptions,
  WorkflowExecutionInput,
  WorkflowExecutionResult,
  WorkflowStepResult,
} from './engine.js';

export { InMemoryWorkflowStateStore } from './workflow-state-store.js';
export { InMemorySuspendedTurnStore } from './suspended-turn-store.js';

export { createWorkflowRuntime } from './workflow-runtime.js';
export type { WorkflowRunnerLike, WorkflowRuntimeOptions } from './workflow-runtime.js';

export { workflowCard, bootstrapWorkflow } from './workflow-agent.js';
export type {
  BootstrapAgentFn,
  WorkflowCardOverrides,
  BootstrapWorkflowOptions,
  RunningWorkflow,
} from './workflow-agent.js';

export { CronScheduler, intervalJob, oneShotJob } from './cron.js';
export type { CronJob, CronSchedulerOptions } from './cron.js';
