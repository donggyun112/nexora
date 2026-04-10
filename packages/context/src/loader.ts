/**
 * ContextLoader — 시스템 프롬프트 + 컨텍스트 조합.
 *
 * 참고: system-prompt.ts buildSystemPrompt()
 *
 * 조합 순서 (고정):
 *   1. 공통 컨텍스트 (common.md, 있으면)
 *   2. persona — 에이전트 정체성
 *   3. tenant.extraContext — 테넌트 추가 컨텍스트
 *   4. runtime — 날짜, workdir, requester 등
 *   5. skills 메뉴
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  ContextLoader as IContextLoader,
  AgentContext,
  ResourceLimits,
  RuntimeContext,
} from '@nexora/contracts';
import { PersonaLoader } from './persona.js';
import { SkillLoader } from './skills.js';
import { TenantConfigStore, DEFAULT_LIMITS } from './tenant.js';

export interface ContextLoaderOptions {
  /** 컨텍스트 루트 디렉토리 (personas/, skills/, tenants/, common.md 포함) */
  root: string;
  /** 기본 도구 목록 (테넌트별 화이트리스트가 없으면 사용) */
  defaultTools?: string[];
  /** 캐시 사용 */
  cache?: boolean;
  /** workdir 베이스 */
  workdirBase?: string;
}

export class CoreContextLoader implements IContextLoader {
  private readonly root: string;
  private readonly personas: PersonaLoader;
  private readonly skills: SkillLoader;
  private readonly tenants: TenantConfigStore;
  private readonly defaultTools: string[];
  private readonly workdirBase: string;
  private commonContext: string | null = null;
  private readonly cacheEnabled: boolean;

  constructor(options: ContextLoaderOptions) {
    this.root = path.resolve(options.root);
    this.cacheEnabled = options.cache ?? true;
    this.personas = new PersonaLoader({ root: this.root, cache: this.cacheEnabled });
    this.skills = new SkillLoader({ root: this.root, cache: this.cacheEnabled });
    this.tenants = new TenantConfigStore({ root: this.root, cache: this.cacheEnabled });
    this.defaultTools = options.defaultTools ?? [];
    this.workdirBase = options.workdirBase ?? process.cwd();
  }

  async load(
    tenantId: string,
    agentName: string,
    overrides?: Partial<AgentContext>,
  ): Promise<AgentContext> {
    const persona = this.personas.load(agentName, tenantId);
    const tenantConfig = this.tenants.load(tenantId);
    const skillsMenu = this.skills.buildMenu(tenantId);
    const common = this.loadCommon();

    const limits: ResourceLimits = {
      ...DEFAULT_LIMITS,
      ...tenantConfig.limits,
      ...overrides?.limits,
    };

    const runtime: RuntimeContext = {
      ...currentRuntime(this.workdirBase),
      ...overrides?.runtime,
    };

    const allowedTools = this.tenants.allowedTools(tenantId, agentName);
    const tools = overrides?.tools ?? allowedTools ?? this.defaultTools;

    const systemPrompt = this.composeSystemPrompt({
      common,
      persona,
      extraContext: tenantConfig.extraContext,
      runtime,
      skillsMenu,
      override: overrides?.systemPrompt,
    });

    return {
      tenantId,
      systemPrompt,
      persona,
      tools,
      limits,
      runtime,
    };
  }

  private composeSystemPrompt(args: {
    common: string;
    persona: string;
    extraContext?: string;
    runtime: RuntimeContext;
    skillsMenu: string;
    override?: string;
  }): string {
    if (args.override) return args.override;

    const runtimeBlock = [
      `Today: ${args.runtime.today} (${args.runtime.weekday})`,
      `This week: ${args.runtime.thisWeek}`,
      `Workspace: ${args.runtime.workdir}`,
      ...(args.runtime.requester ? [`Requester: ${args.runtime.requester}`] : []),
    ].join('\n');

    const parts = [
      args.common,
      args.persona,
      args.extraContext ?? '',
      runtimeBlock,
      args.skillsMenu,
    ].filter(p => p && p.trim().length > 0);

    return parts.join('\n\n---\n\n');
  }

  private loadCommon(): string {
    if (this.cacheEnabled && this.commonContext !== null) return this.commonContext;
    const file = path.join(this.root, 'common.md');
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    if (this.cacheEnabled) this.commonContext = content;
    return content;
  }

  clearCache(): void {
    this.commonContext = null;
    this.personas.clearCache();
    this.skills.clearCache();
    this.tenants.clearCache();
  }
}

/** 현재 시각 기반 RuntimeContext 생성 (UTC 기준) */
export function currentRuntime(workdir: string): RuntimeContext {
  const now = new Date();
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const weekday = weekdays[now.getUTCDay()];

  // 이번 주 범위 (월~일)
  const dayOfWeek = now.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const thisWeek = `${monday.toISOString().slice(0, 10)} ~ ${sunday.toISOString().slice(0, 10)}`;

  return { today, weekday, thisWeek, workdir };
}
