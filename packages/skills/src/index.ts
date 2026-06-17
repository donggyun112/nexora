/**
 * @dongkseo/skills — Self-learning skills system.
 *
 * Skills are procedural knowledge packages (YAML frontmatter + Markdown body)
 * that agents can discover, use, and create at runtime.
 *
 * - SkillLoader: parse SKILL.md files from filesystem
 * - SkillRegistry: search/filter/format skills for prompt injection
 * - SkillCreator: agent auto-creates skills from successful tasks
 */

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
