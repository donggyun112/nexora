/**
 * SkillCreator — agent auto-creates skills from successful task completions.
 *
 * When an agent successfully completes a complex task, the skill creator
 * can distill the approach into a reusable SKILL.md file. This enables
 * self-learning: the agent gets better over time by building a library
 * of procedural knowledge.
 *
 * Flow:
 * 1. Agent completes a task successfully
 * 2. skill-creator extracts the approach (steps, tools used, patterns)
 * 3. Generates a SKILL.md with frontmatter + Markdown body
 * 4. Saves to the agent-created skills directory
 * 5. SkillRegistry picks it up on next load
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Skill, SkillFrontmatter } from './types.js';
import { parseSkillFile } from './skill-loader.js';

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SKILL_NAME_MAX_LEN = 64;

function validateSkillName(name: string): void {
  if (!name || name.length > SKILL_NAME_MAX_LEN) {
    throw new Error(`Skill name must be 1-${SKILL_NAME_MAX_LEN} characters: "${name}"`);
  }
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Skill name must match ${SKILL_NAME_RE}: "${name}"`);
  }
}

/** Escape a string for safe YAML value embedding. Wraps in quotes if needed. */
function escapeYamlValue(value: string): string {
  // If value contains special YAML chars, wrap in double quotes with escaping
  if (/[\n\r:#{}\[\],&*?|>!%@`"']/.test(value) || value.includes('---')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return value;
}

export interface SkillCreatorOptions {
  /** Directory where agent-created skills are saved */
  outputDir: string;
}

export interface CreateSkillInput {
  /** What was the task? */
  taskDescription: string;
  /** What steps were taken? */
  steps: string[];
  /** What tools were used? */
  toolsUsed: string[];
  /** Tags for categorization */
  tags: string[];
  /** Optional: name override (auto-generated if not provided) */
  name?: string;
}

export class SkillCreator {
  private readonly outputDir: string;

  constructor(options: SkillCreatorOptions) {
    this.outputDir = options.outputDir;
  }

  /**
   * Create a new skill from a successful task completion.
   * Returns the created Skill object.
   */
  async create(input: CreateSkillInput): Promise<Skill> {
    const name = input.name ?? this.generateName(input.taskDescription);
    validateSkillName(name);
    const skillDir = path.join(this.outputDir, name);
    // Path traversal prevention: resolved path must be under outputDir
    const resolved = path.resolve(skillDir);
    const root = path.resolve(this.outputDir);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`Skill name "${name}" resolves outside output directory`);
    }

    const frontmatter: SkillFrontmatter = {
      name,
      description: input.taskDescription,
      tags: input.tags,
      version: 1,
      author: 'agent',
    };

    const body = this.generateBody(input);
    const content = this.serializeSkill(frontmatter, body);

    // Ensure output directory exists
    if (!fs.existsSync(skillDir)) {
      await fsp.mkdir(skillDir, { recursive: true });
    }

    const filePath = path.join(skillDir, 'SKILL.md');
    await fsp.writeFile(filePath, content, 'utf-8');

    return parseSkillFile(content, filePath);
  }

  /**
   * Update an existing skill (increment version, merge steps).
   */
  async update(existingSkill: Skill, additionalSteps: string[]): Promise<Skill> {
    const newMeta = {
      ...existingSkill.meta,
      version: existingSkill.meta.version + 1,
    };

    // Append new steps to existing body
    const additionalBody = additionalSteps.map((s, i) =>
      `${existingSkill.body.split('\n').filter(l => l.match(/^\d+\./)).length + i + 1}. ${s}`
    ).join('\n');

    const body = `${existingSkill.body}\n\n### Additional Steps (v${newMeta.version})\n${additionalBody}`;
    const content = this.serializeSkill(newMeta, body);

    await fsp.writeFile(existingSkill.source, content, 'utf-8');
    return parseSkillFile(content, existingSkill.source);
  }

  private generateName(description: string): string {
    const name = description
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 64);
    // Validate: ^[a-z0-9][a-z0-9._-]*$
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      return `skill-${Date.now()}`;
    }
    return name;
  }

  private generateBody(input: CreateSkillInput): string {
    const lines: string[] = [];
    lines.push(`# ${input.taskDescription}`);
    lines.push('');

    if (input.toolsUsed.length > 0) {
      lines.push('## Tools Required');
      for (const tool of input.toolsUsed) {
        lines.push(`- ${tool}`);
      }
      lines.push('');
    }

    lines.push('## Steps');
    for (let i = 0; i < input.steps.length; i++) {
      lines.push(`${i + 1}. ${input.steps[i]}`);
    }

    return lines.join('\n');
  }

  private serializeSkill(meta: SkillFrontmatter, body: string): string {
    const frontmatter = [
      '---',
      `name: ${escapeYamlValue(meta.name)}`,
      `description: ${escapeYamlValue(meta.description)}`,
      `tags: [${meta.tags.map(t => escapeYamlValue(t)).join(', ')}]`,
      meta.trigger ? `trigger: ${escapeYamlValue(meta.trigger)}` : null,
      `version: ${meta.version}`,
      `author: ${meta.author}`,
      '---',
    ].filter(Boolean).join('\n');

    return `${frontmatter}\n\n${body}\n`;
  }
}
