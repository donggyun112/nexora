/**
 * PersonaLoader — 에이전트별 페르소나 파일 로딩.
 *
 * 디렉토리 구조:
 *   contextRoot/
 *     personas/
 *       {agent-name}.md         # 기본
 *     tenants/{tenantId}/personas/
 *       {agent-name}.md         # 테넌트 오버라이드
 *
 * 페르소나는 LLM에 주입할 정체성/역할 텍스트.
 * 파일이 없으면 기본 문자열을 사용.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PERSONA = 'You are a helpful assistant.';

export interface PersonaLoaderOptions {
  /** 컨텍스트 루트 디렉토리 */
  root: string;
  /** 캐싱 활성화 (기본 true) */
  cache?: boolean;
  /**
   * 기본 persona 파일 경로를 커스텀 해석한다. 반환 경로가 실제로 존재하면 그것을,
   * 없으면 root/personas/<name>.md 컨벤션으로 폴백한다 (점진적 마이그레이션 안전).
   */
  resolveDefaultPath?: (agentName: string, tenantId?: string) => string | null | undefined;
}

export class PersonaLoader {
  private readonly root: string;
  private readonly cacheEnabled: boolean;
  private readonly resolveDefaultPath?: PersonaLoaderOptions['resolveDefaultPath'];
  private readonly cache = new Map<string, string>();

  constructor(options: PersonaLoaderOptions) {
    this.root = path.resolve(options.root);
    this.cacheEnabled = options.cache ?? true;
    this.resolveDefaultPath = options.resolveDefaultPath;
  }

  /**
   * 페르소나 로드. 테넌트 오버라이드 우선.
   */
  load(agentName: string, tenantId?: string): string {
    const cacheKey = `${tenantId ?? '__default__'}:${agentName}`;
    if (this.cacheEnabled && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const tenantPath = tenantId
      ? path.join(this.root, 'tenants', tenantId, 'personas', `${agentName}.md`)
      : null;
    const resolved = this.resolveDefaultPath?.(agentName, tenantId);
    const defaultPath =
      resolved && fs.existsSync(resolved)
        ? resolved
        : path.join(this.root, 'personas', `${agentName}.md`);

    let content = DEFAULT_PERSONA;
    if (tenantPath && fs.existsSync(tenantPath)) {
      content = fs.readFileSync(tenantPath, 'utf-8');
    } else if (fs.existsSync(defaultPath)) {
      content = fs.readFileSync(defaultPath, 'utf-8');
    }

    if (this.cacheEnabled) this.cache.set(cacheKey, content);
    return content;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
