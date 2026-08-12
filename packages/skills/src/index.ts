// ─── Skills: 런타임 스킬(절차적 지식) 로드·검색·메뉴·생성 ───────────────────
//
// 섹션 맵 (에이전트용: 무엇이 어느 파일에 있는지 — 정확한 타입은 해당 파일을 signatures 모드로)
//   타입          ./types          SkillMetadata, Skill, SkillSource
//   디렉터리 소스 ./skill-loader   DirectorySkillSource
//   레지스트리    ./skill-registry SkillRegistry (metadata precedence + bounded catalog)
//   지연 도구     ./skill-tools    SkillTools (single `skill` tool + on-demand body context)
//
// 스킬 = YAML frontmatter + Markdown 본문 파일. 에이전트가 런타임에 발견·사용·생성한다.

export { Skill } from './types.js';
export type { SkillMetadata, SkillOptions, SkillSource } from './types.js';

export { DirectorySkillSource } from './skill-loader.js';

export { SkillRegistry } from './skill-registry.js';
export type { SkillRegistryOptions } from './skill-registry.js';

export { SkillTools } from './skill-tools.js';
