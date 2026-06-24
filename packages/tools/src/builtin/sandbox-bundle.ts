/**
 * 샌드박스 빌트인 도구 묶음 — createSandboxProvider로 워크스페이스를 격리한
 * 소비 프로젝트가 한 번에 등록하는 파일/프로세스 도구 세트.
 *
 * read/write/edit/grep는 ctx.workspace.resolve()/run()을 통해 워크스페이스 경계
 * 안에서 동작하고, exec는 ctx.workspace.run()으로 샌드박스 안에서 임의 명령을
 * 실행한다. exec의 allowList 등 하드닝은 소비자가 options.exec로 정한다.
 */

import type { ToolDefinition } from '@dongkseo/contracts';
import { createReadTool } from './read.js';
import { createWriteTool } from './write.js';
import { createEditTool } from './edit.js';
import { createGrepTool } from './grep.js';
import { createExecTool, type ExecToolOptions } from './exec.js';
import type { ToolRegistry } from '../registry.js';

export interface SandboxToolBundleOptions {
  /** exec 도구 하드닝(allowList/allowShell/timeout). 미지정 시 createExecTool 기본값. */
  exec?: ExecToolOptions;
}

/** read/write/edit/grep/exec 도구 정의 묶음을 만든다. */
export function sandboxToolDefinitions(
  options: SandboxToolBundleOptions = {},
): ToolDefinition[] {
  return [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createGrepTool(),
    createExecTool(options.exec ?? {}),
  ];
}

/** 묶음을 ToolRegistry에 등록한다. */
export function registerSandboxTools(
  registry: ToolRegistry,
  options: SandboxToolBundleOptions = {},
): void {
  registry.registerAll(sandboxToolDefinitions(options));
}
