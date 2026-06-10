/**
 * Context — 테넌트/유저 컨텍스트 계약.
 *
 * 기존 system-prompt.ts의 SystemPromptOptions, loadCompanyContext,
 * getGuildKnowledgeDir 등을 일반화.
 *
 * 같은 에이전트 바이너리라도 컨텍스트에 따라 다른 에이전트가 됨.
 */

export interface AgentContext {
  /** 테넌트 ID */
  tenantId: string;

  /**
   * Tenant + agent scope resolved by the context loader.
   * New framework paths should pass this through to tools and stores so
   * namespace decisions are made consistently.
   */
  scope?: TenantAgentScope;

  /** 조합된 시스템 프롬프트 */
  systemPrompt: string;

  /** 페르소나 (에이전트 정체성) */
  persona: string;

  /** 테넌트/에이전트별 허용 도구 목록 */
  tools: string[];

  /** 리소스 제한 */
  limits: ResourceLimits;

  /** 런타임 컨텍스트 (날짜, 요청자 등) */
  runtime: RuntimeContext;
}

export interface ResourceLimits {
  /** 최대 실행 시간 (ms) */
  maxExecutionMs: number;

  /** 최대 토큰 */
  maxTokens: number;

  /** LLM 모델 */
  model: string;

  /** thinking 레벨 — 기존 AGENT_THINKING 설정 */
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

  /** 컨텍스트 윈도우 크기 — 기존 DEFAULT_CONTEXT_WINDOW */
  contextWindow: number;
}

export interface RuntimeContext {
  /** 오늘 날짜 (YYYY-MM-DD) */
  today: string;

  /** 요일 */
  weekday: string;

  /** 이번 주 범위 */
  thisWeek: string;

  /** 작업 디렉토리 */
  workdir: string;

  /** 요청자 이름 */
  requester?: string;
}

export interface TenantAgentScope {
  /** Tenant boundary for isolation and policy lookup. */
  tenantId: string;
  /** Agent name inside the tenant boundary. */
  agentName: string;
  /** Stable namespace for tenant-agent scoped stores and audit records. */
  namespace: string;
}

export function createTenantAgentScope(
  tenantId: string,
  agentName: string,
): TenantAgentScope {
  return {
    tenantId,
    agentName,
    namespace: tenantAgentScopeKey({ tenantId, agentName }),
  };
}

export function tenantAgentScopeKey(scope: Pick<TenantAgentScope, 'tenantId' | 'agentName'>): string {
  return `${sanitizeScopePart(scope.tenantId)}:${sanitizeScopePart(scope.agentName)}`;
}

function sanitizeScopePart(value: string): string {
  const trimmed = value.trim();
  return (trimmed.length > 0 ? trimmed : 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * ContextLoader — 컨텍스트를 조합하는 인터페이스.
 * context 패키지에서 구현.
 */
export interface ContextLoader {
  load(tenantId: string, agentName: string, overrides?: Partial<AgentContext>): Promise<AgentContext>;
}
