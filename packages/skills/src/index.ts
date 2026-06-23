// ─── Skills: 런타임 스킬(절차적 지식) 로드·검색·메뉴·생성 ───────────────────
//
// 섹션 맵 (에이전트용: 무엇이 어느 파일에 있는지 — 정확한 타입은 해당 파일을 signatures 모드로)
//   타입          ./types         Skill, SkillFrontmatter, SkillMatch
//   로드/파싱     ./skill-loader  parseSkillFile, loadSkills, loadSkillsFromDir, defaultSkillSources
//   적격성 필터   ./skill-loader  filterEligibleSkills, SkillEligibilityContext, CachedSkillLoader
//   레지스트리    ./skill-registry  SkillRegistry (register/search/list/formatForPrompt …)
//   자동 생성     ./skill-creator   SkillCreator, CreateSkillInput, SkillCreatorOptions
//   메뉴 빌드     ./skill-menu    buildSkillMenu, BuildSkillMenuOptions, SkillMenuFilter/Preamble
//   메뉴 스냅샷   ./skill-menu    snapshotSkills, invalidateSkillMenuCache, refresh/getLastSkillMenuSnapshot
//   본문 후처리   ./skill-body-postprocess  postProcessSkillBody, PostProcessSkillOptions
//
// 스킬 = YAML frontmatter + Markdown 본문 파일. 에이전트가 런타임에 발견·사용·생성한다.

export type { Skill, SkillFrontmatter, SkillMatch } from './types.js';

export {
  parseSkillFile,
  loadSkillsFromDir,
  loadSkills,
  defaultSkillSources,
  CachedSkillLoader,
  filterEligibleSkills,
} from './skill-loader.js';
export type { SkillEligibilityContext } from './skill-loader.js';

export { SkillRegistry } from './skill-registry.js';

export { SkillCreator } from './skill-creator.js';
export type { SkillCreatorOptions, CreateSkillInput } from './skill-creator.js';

export {
  buildSkillMenu,
  getLastSkillMenuSnapshot,
  invalidateSkillMenuCache,
  refreshSkillMenuSnapshot,
  snapshotSkills,
} from './skill-menu.js';
export type {
  BuildSkillMenuOptions,
  SkillMenuPreamble,
  SkillMenuFilter,
  SkillMenuSnapshotEntry,
} from './skill-menu.js';

export { postProcessSkillBody } from './skill-body-postprocess.js';
export type { PostProcessSkillOptions } from './skill-body-postprocess.js';
