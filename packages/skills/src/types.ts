/**
 * Skill types — YAML frontmatter + Markdown body.
 *
 * Skills are procedural knowledge packages: "how to do X" expressed as
 * structured instructions an LLM can follow. Unlike tools (which are
 * executable functions), skills are injected into the system prompt or
 * user message as context.
 *
 * Format:
 * ```markdown
 * ---
 * name: code-review
 * description: Review code for quality, bugs, and security
 * tags: [code, review, quality]
 * trigger: "review this code"
 * version: 1
 * author: system | agent
 * ---
 *
 * # Code Review Skill
 *
 * ## Steps
 * 1. Read the file(s) to review
 * 2. Check for correctness issues
 * ...
 * ```
 */

export interface SkillFrontmatter {
  /** Unique skill name (kebab-case) */
  name: string;
  /** One-line description for search/matching */
  description: string;
  /** Tags for filtering and search */
  tags: string[];
  /** Optional trigger phrase — when user says this, suggest this skill */
  trigger?: string;
  /** Schema version (increment on breaking changes) */
  version: number;
  /** Who created: 'system' (builtin) or 'agent' (auto-created) */
  author: 'system' | 'agent';
  /** Tools this skill requires or is allowed to use */
  allowedTools?: string[];
  /** Platform constraints (e.g., ['macos', 'linux']) */
  platforms?: string[];
  /** Prerequisites (other skills or capabilities needed) */
  prerequisites?: string[];
  /** Arbitrary metadata (nested objects supported) */
  metadata?: Record<string, unknown>;

  // ─── Conditional activation (hermes pattern) ─────────────────────
  /** Only activate when ALL of these toolsets are available */
  requires_toolsets?: string[];
  /** Activate as fallback when ANY of these toolsets are unavailable */
  fallback_for_toolsets?: string[];
  /** Required environment variables (openclaw pattern) */
  requires_env?: string[];
  /** Required binaries on PATH (openclaw pattern) */
  requires_bins?: string[];
  /** Always include regardless of filtering. Default: false */
  always?: boolean;
}

export interface Skill {
  /** Parsed frontmatter */
  meta: SkillFrontmatter;
  /** Raw Markdown body (instructions for the LLM) */
  body: string;
  /** Source file path (for debugging/editing) */
  source: string;
}

export interface SkillMatch {
  skill: Skill;
  /** 0.0–1.0 relevance score */
  score: number;
}
