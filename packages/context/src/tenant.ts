/**
 * TenantConfigStore — 테넌트별 설정 해석.
 *
 * 디렉토리 구조:
 *   contextRoot/
 *     tenants/
 *       {tenantId}/
 *         tenant.json    # 설정 파일
 *
 * 설정에는 모델, thinking 레벨, max tokens, 허용 도구, 페르소나 오버라이드 등 포함.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ResourceLimits } from '@nexora/contracts';

export interface TenantConfig {
  /** 테넌트 ID (디렉토리명과 일치) */
  id: string;
  /** 표시 이름 */
  name?: string;
  /** 기본 리소스 제한 */
  limits?: Partial<ResourceLimits>;
  /** 에이전트별 도구 화이트리스트 (없으면 모든 도구 허용) */
  allowedToolsByAgent?: Record<string, string[]>;
  /** 추가 컨텍스트 (시스템 프롬프트에 주입) */
  extraContext?: string;
  /** 임의 설정 (프로젝트별 확장) */
  metadata?: Record<string, unknown>;
}

export interface TenantConfigStoreOptions {
  root: string;
  cache?: boolean;
}

const DEFAULT_LIMITS: ResourceLimits = {
  maxExecutionMs: 600_000,
  maxTokens: 8_192,
  model: 'claude-sonnet-4-5',
  thinkingLevel: 'low',
  contextWindow: 256_000,
};

export class TenantConfigStore {
  private readonly root: string;
  private readonly cacheEnabled: boolean;
  private readonly cache = new Map<string, TenantConfig>();

  constructor(options: TenantConfigStoreOptions) {
    this.root = path.resolve(options.root);
    this.cacheEnabled = options.cache ?? true;
  }

  /** 테넌트 설정 로드 (없으면 기본값) */
  load(tenantId: string): TenantConfig {
    if (this.cacheEnabled && this.cache.has(tenantId)) {
      return this.cache.get(tenantId)!;
    }

    const file = path.join(this.root, 'tenants', tenantId, 'tenant.json');
    let config: TenantConfig = { id: tenantId };

    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<TenantConfig>;
        config = { ...parsed, id: tenantId };
      } catch (err) {
        console.warn(`[TenantConfigStore] Failed to parse ${file}:`, err);
      }
    }

    if (this.cacheEnabled) this.cache.set(tenantId, config);
    return config;
  }

  /** 테넌트 limits를 기본값과 머지 */
  mergedLimits(tenantId: string): ResourceLimits {
    const config = this.load(tenantId);
    return { ...DEFAULT_LIMITS, ...config.limits };
  }

  /** 에이전트에 허용된 도구 (config 없으면 null = 모두 허용) */
  allowedTools(tenantId: string, agentName: string): string[] | null {
    const config = this.load(tenantId);
    return config.allowedToolsByAgent?.[agentName] ?? null;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export { DEFAULT_LIMITS };
