/**
 * ToolRegistry — 도구 등록/필터/조립.
 *
 * 참고: Claude Code의 tools.ts assembleToolPool 패턴.
 *
 * 사용:
 *   const registry = new ToolRegistry();
 *   registry.register(execTool);
 *   registry.register(readTool);
 *   const filtered = registry.assemble({ allowed: ['exec'] });
 */

import type { ToolDefinition } from '@nexora/contracts';

export interface ToolFilter {
  /** 허용할 도구 이름 (지정 시 화이트리스트) */
  allowed?: string[];
  /** 차단할 도구 이름 (지정 시 블랙리스트) */
  blocked?: string[];
  /** 이름 패턴으로 필터 */
  pattern?: RegExp;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /** 도구 등록 (이미 있으면 덮어쓰기) */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** 여러 도구 한 번에 등록 */
  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  /** 도구 제거 */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** 단일 도구 조회 */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** 도구 존재 여부 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 등록된 모든 도구 */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** 등록된 도구 이름 목록 */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 등록된 도구 수 */
  size(): number {
    return this.tools.size;
  }

  /**
   * 필터 기준으로 도구를 조립.
   * 에이전트별 허용 도구 셋을 만들 때 사용.
   *
   * 우선순위: pattern → blocked → allowed
   */
  assemble(filter: ToolFilter = {}): ToolDefinition[] {
    let tools = this.list();

    if (filter.pattern) {
      tools = tools.filter(t => filter.pattern!.test(t.name));
    }

    if (filter.blocked && filter.blocked.length > 0) {
      const blocked = new Set(filter.blocked);
      tools = tools.filter(t => !blocked.has(t.name));
    }

    if (filter.allowed && filter.allowed.length > 0) {
      const allowed = new Set(filter.allowed);
      tools = tools.filter(t => allowed.has(t.name));
    }

    return tools;
  }

  /** 모든 도구 제거 */
  clear(): void {
    this.tools.clear();
  }
}
