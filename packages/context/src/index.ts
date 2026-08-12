// ─── Context: 에이전트 실행 전 컨텍스트(시스템 프롬프트) 조립 ──────────────
//
// 섹션 맵 (에이전트용: 무엇이 어느 파일에 있는지 — 정확한 타입은 해당 파일을 signatures 모드로)
//   Loader   ./loader   CoreContextLoader, currentRuntime, ContextLoaderOptions  — 모두 조합한 AgentContext 빌더
//   Persona  ./persona  PersonaLoader, PersonaLoaderOptions                      — 에이전트별 페르소나 로딩/캐시
//   Tenant   ./tenant   TenantConfigStore, DEFAULT_LIMITS, TenantConfig          — 테넌트별 설정/limits/도구 화이트리스트
//
// 의존 방향: context → @dongkseo/contracts (단방향). 실행 로직 없음, 컨텍스트 조립만.

export { PersonaLoader } from './persona.js';
export type { PersonaLoaderOptions } from './persona.js';


export { TenantConfigStore, DEFAULT_LIMITS } from './tenant.js';
export type { TenantConfig, TenantConfigStoreOptions } from './tenant.js';

export { CoreContextLoader, currentRuntime } from './loader.js';
export type { ContextLoaderOptions } from './loader.js';
