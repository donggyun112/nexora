/**
 * skill_manage — agent-invocable skill lifecycle tool.
 *
 * The agent calls this DURING execution to manage its own skills:
 * - load: read a skill's content for reference
 * - list: see all available skills
 * - create: save a new reusable skill from experience
 * - patch: fix/update an existing skill
 * - delete: remove an obsolete skill
 *
 * This makes the agent SELF-AWARE of its skills — it can decide
 * to create a skill when it succeeds at something complex, or
 * patch a skill when it finds the instructions are wrong.
 *
 * Based on Hermes skill_manager_tool.py.
 */

import type { ToolDefinition, ToolResult } from '@nexora/contracts';
import { textResult, errorResult } from '@nexora/contracts';

export interface SkillManageToolOptions {
  /**
   * Load skill content by name.
   * Integrates with SkillRegistry.get() + read body.
   */
  loadSkill: (name: string) => Promise<string | null>;
  /**
   * List all available skills.
   * Integrates with SkillRegistry.list().
   */
  listSkills: () => Promise<Array<{ name: string; description: string; author: string }>>;
  /**
   * Create a new skill. Content must be valid SKILL.md format.
   * Integrates with SafeSkillWriter.create().
   * Returns skill name or throws on validation/security failure.
   */
  createSkill: (content: string) => Promise<string>;
  /**
   * Patch an existing skill (find-and-replace).
   * Integrates with SafeSkillWriter.patch().
   */
  patchSkill: (name: string, oldText: string, newText: string) => Promise<void>;
  /**
   * Delete a skill.
   * Integrates with SafeSkillWriter.delete().
   */
  deleteSkill: (name: string) => Promise<void>;
  /**
   * Optional: callback after skill mutation for cache invalidation.
   */
  onSkillChanged?: () => void;
}

export function createSkillManageTool(options: SkillManageToolOptions): ToolDefinition {
  return {
    name: 'skill_manage',
    description:
      'Manage your own skills — reusable procedures you\'ve learned. ' +
      'Actions: "list" (see all skills), "load" (read a skill), ' +
      '"create" (save new skill from experience), "patch" (fix a skill), ' +
      '"delete" (remove obsolete skill).\n\n' +
      'CREATE a skill when:\n' +
      '- You completed a complex task successfully (5+ steps)\n' +
      '- You discovered a non-obvious approach\n' +
      '- The user taught you something reusable\n\n' +
      'PATCH a skill when:\n' +
      '- You followed a skill but hit an issue not covered\n' +
      '- Instructions are outdated or wrong\n\n' +
      'Skill format (SKILL.md with YAML frontmatter):\n' +
      '---\n' +
      'name: kebab-case-name\n' +
      'description: What this skill does\n' +
      'tags: [relevant, tags]\n' +
      'version: 1\n' +
      'author: agent\n' +
      '---\n\n' +
      '# Skill Title\n\n## Steps\n1. Step one\n...',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'load', 'create', 'patch', 'delete'],
          description: 'Operation to perform',
        },
        name: {
          type: 'string',
          description: 'Skill name (for load/patch/delete)',
        },
        content: {
          type: 'string',
          description: 'Full SKILL.md content (for create)',
        },
        old_text: {
          type: 'string',
          description: 'Text to find (for patch)',
        },
        new_text: {
          type: 'string',
          description: 'Replacement text (for patch)',
        },
      },
      required: ['action'],
    },

    execute: async (_id, input, _ctx): Promise<ToolResult> => {
      const params = input as {
        action: string;
        name?: string;
        content?: string;
        old_text?: string;
        new_text?: string;
      };

      try {
        switch (params.action) {
          case 'list': {
            const skills = await options.listSkills();
            if (skills.length === 0) {
              return textResult('No skills available yet. Create one after completing a complex task!');
            }
            const lines = skills.map(s =>
              `- **${s.name}**: ${s.description} (${s.author})`
            );
            return textResult(`Available skills (${skills.length}):\n${lines.join('\n')}`);
          }

          case 'load': {
            if (!params.name) return errorResult('"name" is required for load');
            const content = await options.loadSkill(params.name);
            if (!content) return textResult(`Skill "${params.name}" not found.`);
            return textResult(content);
          }

          case 'create': {
            if (!params.content) return errorResult('"content" is required for create. Provide full SKILL.md.');
            const name = await options.createSkill(params.content);
            options.onSkillChanged?.();
            return textResult(`Skill "${name}" created successfully. It will be available in future sessions.`);
          }

          case 'patch': {
            if (!params.name) return errorResult('"name" is required for patch');
            if (!params.old_text) return errorResult('"old_text" is required for patch');
            if (!params.new_text) return errorResult('"new_text" is required for patch');
            await options.patchSkill(params.name, params.old_text, params.new_text);
            options.onSkillChanged?.();
            return textResult(`Skill "${params.name}" patched successfully.`);
          }

          case 'delete': {
            if (!params.name) return errorResult('"name" is required for delete');
            await options.deleteSkill(params.name);
            options.onSkillChanged?.();
            return textResult(`Skill "${params.name}" deleted.`);
          }

          default:
            return errorResult(`Unknown action "${params.action}". Use: list, load, create, patch, delete.`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`skill_manage.${params.action} failed: ${msg}`);
      }
    },
  };
}
