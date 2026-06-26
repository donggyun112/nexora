/**
 * 모니터링/자가-깨움 빌트인 도구 묶음 — 한 번에 등록하는 셀프-웨이크 + 백그라운드
 * 관찰 도구 세트.
 *
 * 이 도구들은 전부 실행 하니스가 ToolContext에 주입하는 핸들(ctx.triggers =
 * TriggerHost, ctx.backgroundTasks = BackgroundTaskRegistry, ctx.steerSelf /
 * ctx.deliverResult 깨움 채널)만 소비한다. 따라서 생성자 인자 없이 묶을 수 있고,
 * 하니스가 주입한 동일 레지스트리/트리거 호스트를 delegate·background exec과 공유한다.
 *
 *   schedule_monitor / cancel_monitor / list_monitors  — 주기적 자가-깨움
 *   watch_task / check_tasks / cancel_task             — 백그라운드 작업 관찰·제어
 *   read_task_output / watch_output                    — 백그라운드 출력 읽기·매칭 깨움
 *
 * 참고: sandbox-bundle.ts (동일 패턴), execution-harness.ts (주입 지점).
 */

import type { ToolDefinition } from '@dongkseo/contracts';
import {
  createScheduleMonitorTool,
  createCancelMonitorTool,
  createListMonitorsTool,
  createWatchOutputTool,
} from './schedule-monitor.js';
import {
  createCheckTasksTool,
  createCancelTasksTool,
  createReadTaskOutputTool,
  createWatchTaskTool,
} from './background-tasks.js';
import type { ToolRegistry } from '../registry.js';

export interface MonitoringToolBundleOptions {
  /**
   * Include the background-task observation tools (watch_task / check_tasks /
   * cancel_task / read_task_output / watch_output). Default true. Set false to
   * ship only the recurring self-wake monitors (schedule_monitor family).
   */
  backgroundTasks?: boolean;
}

/**
 * Recurring self-wake monitors + background-task observation tools as a single
 * tool-definition bundle. All deps come from the ToolContext the harness
 * injects — no constructor wiring required.
 */
export function monitoringToolDefinitions(
  options: MonitoringToolBundleOptions = {},
): ToolDefinition[] {
  const { backgroundTasks = true } = options;
  const tools: ToolDefinition[] = [
    createScheduleMonitorTool(),
    createCancelMonitorTool(),
    createListMonitorsTool(),
  ];
  if (backgroundTasks) {
    tools.push(
      createWatchTaskTool(),
      createCheckTasksTool(),
      createCancelTasksTool(),
      createReadTaskOutputTool(),
      createWatchOutputTool(),
    );
  }
  return tools;
}

/** 묶음을 ToolRegistry에 등록한다. */
export function registerMonitoringTools(
  registry: ToolRegistry,
  options: MonitoringToolBundleOptions = {},
): void {
  registry.registerAll(monitoringToolDefinitions(options));
}
