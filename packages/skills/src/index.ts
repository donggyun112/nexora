/**
 * @nexora/skills — Self-learning skills system.
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
} from './skill-loader.js';

export { SkillRegistry } from './skill-registry.js';

export { SkillCreator } from './skill-creator.js';
export type { SkillCreatorOptions, CreateSkillInput } from './skill-creator.js';
