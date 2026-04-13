/**
 * SkillRegistry — search and filter skills by query, tags, or trigger.
 *
 * Provides keyword-based matching (no embeddings required) with
 * TF-IDF-like scoring. For semantic search, use with an embedding
 * provider (future: store-memory package).
 */

import type { Skill, SkillMatch } from './types.js';

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class SkillRegistry {
  private skills: Skill[] = [];

  /** Register a single skill. Replaces existing skill with same name. */
  register(skill: Skill): void {
    this.skills = this.skills.filter(s => s.meta.name !== skill.meta.name);
    this.skills.push(skill);
  }

  /** Register multiple skills at once. */
  registerAll(skills: Skill[]): void {
    for (const skill of skills) this.register(skill);
  }

  /** Unregister a skill by name. */
  unregister(name: string): void {
    this.skills = this.skills.filter(s => s.meta.name !== name);
  }

  /** Get a skill by exact name. */
  get(name: string): Skill | undefined {
    return this.skills.find(s => s.meta.name === name);
  }

  /** List all registered skills. */
  list(): readonly Skill[] {
    return this.skills;
  }

  /** Filter skills by tag. */
  filterByTag(tag: string): Skill[] {
    return this.skills.filter(s => s.meta.tags.includes(tag));
  }

  /**
   * Search skills by text query. Scores based on:
   * - Exact name match → 1.0
   * - Trigger phrase match → 0.9
   * - Description word overlap → 0.3–0.7
   * - Tag match → 0.5
   * - Body keyword presence → 0.1–0.3
   *
   * Returns results sorted by score, descending.
   */
  search(query: string, limit = 5): SkillMatch[] {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    const matches: SkillMatch[] = [];

    for (const skill of this.skills) {
      let score = 0;
      const { name, description, tags, trigger } = skill.meta;

      // Exact name match
      if (name.toLowerCase() === queryLower) {
        score = 1.0;
      } else if (name.toLowerCase().includes(queryLower) || queryLower.includes(name.toLowerCase())) {
        score = Math.max(score, 0.8);
      }

      // Trigger match
      if (trigger) {
        const triggerLower = trigger.toLowerCase();
        if (triggerLower.includes(queryLower) || queryLower.includes(triggerLower)) {
          score = Math.max(score, 0.9);
        }
      }

      // Tag match
      for (const tag of tags) {
        if (queryWords.some(w => tag.toLowerCase().includes(w))) {
          score = Math.max(score, 0.5);
        }
      }

      // Description word overlap
      const descLower = description.toLowerCase();
      let descHits = 0;
      for (const word of queryWords) {
        if (descLower.includes(word)) descHits++;
      }
      if (queryWords.length > 0) {
        const descScore = 0.3 + 0.4 * (descHits / queryWords.length);
        score = Math.max(score, descScore);
      }

      // Body keyword presence (lightweight — just check presence)
      const bodyLower = skill.body.toLowerCase();
      let bodyHits = 0;
      for (const word of queryWords) {
        if (bodyLower.includes(word)) bodyHits++;
      }
      if (queryWords.length > 0) {
        const bodyScore = 0.1 + 0.2 * (bodyHits / queryWords.length);
        score = Math.max(score, bodyScore);
      }

      if (score > 0.1) {
        matches.push({ skill, score });
      }
    }

    return matches
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Format a skill for injection into the system prompt or user message.
   * Uses XML tags following the Agent Skills standard for interoperability.
   */
  formatForPrompt(skill: Skill): string {
    const safeName = escapeXml(skill.meta.name);
    const safeBody = skill.body.replace(/<\/skill>/gi, '&lt;/skill&gt;');
    return `<skill name="${safeName}">\n${safeBody}\n</skill>`;
  }

  /**
   * Format skill catalog for system prompt injection.
   * Progressive disclosure: shows name + description + source path.
   * The agent uses the `read` tool to load the full skill body when needed.
   */
  formatCatalogForPrompt(skills: Skill[]): string {
    if (skills.length === 0) return '';
    const entries = skills.map(s =>
      `  <skill>\n` +
      `    <name>${escapeXml(s.meta.name)}</name>\n` +
      `    <description>${escapeXml(s.meta.description)}</description>\n` +
      `    <location>${escapeXml(s.source)}</location>\n` +
      `  </skill>`
    );
    return `<available_skills>\n${entries.join('\n')}\n</available_skills>`;
  }

  /**
   * Format multiple skills for full prompt injection (when loaded on-demand).
   */
  formatManyForPrompt(skills: Skill[]): string {
    if (skills.length === 0) return '';
    const formatted = skills.map(s => this.formatForPrompt(s));
    return `<skills>\n${formatted.join('\n\n')}\n</skills>`;
  }
}
