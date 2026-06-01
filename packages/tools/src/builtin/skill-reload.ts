/**
 * skill_reload — 디스크의 스킬 변경을 감지해서 메뉴 캐시 무효화 + diff 반환.
 *
 * 봇 운용 중 새 스킬을 추가/삭제했을 때 봇 재시작 없이 LLM 메뉴 갱신용.
 * Hermes `reload_skills` 의 시그니처를 따라 added/removed 두 리스트로 응답.
 *
 * @nexora/skills 의 invalidateSkillMenuCache + snapshotSkills 와 짝.
 */

import path from 'node:path';
import {
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
} from '@nexora/contracts';
import {
  invalidateSkillMenuCache,
  snapshotSkills,
} from '@nexora/skills';

export interface SkillReloadToolOptions {
  readonly agentSkillsDir: string;
  readonly sharedSkillsDir?: string;
}

export function createSkillReloadTool(options: SkillReloadToolOptions): ToolDefinition {
  return {
    name: 'skill_reload',
    description:
      'Rescan skill directories from disk and invalidate the in-process skill menu cache. ' +
      'Returns { added, removed, total } for skills that changed since the last menu build. ' +
      'Use after manually adding or removing a SKILL.md while the bot is running — without it, ' +
      'the system prompt menu stays stale until the next restart.',
    parameters: { type: 'object', properties: {}, required: [] } as Record<string, unknown>,
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    async execute(_callId: string, _rawInput: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const before = snapshotSkills(options.agentSkillsDir, options.sharedSkillsDir);
      invalidateSkillMenuCache();
      const after = snapshotSkills(options.agentSkillsDir, options.sharedSkillsDir);

      const beforeMap = new Map(before.map((s) => [s.name, s.description]));
      const afterMap = new Map(after.map((s) => [s.name, s.description]));

      const added: Array<{ name: string; description: string }> = [];
      const removed: Array<{ name: string; description: string }> = [];
      for (const s of after) {
        if (!beforeMap.has(s.name)) added.push(s);
      }
      for (const s of before) {
        if (!afterMap.has(s.name)) removed.push(s);
      }

      return {
        type: 'text',
        text: JSON.stringify(
          {
            added,
            removed,
            total: after.length,
            agentSkillsDir: path.basename(options.agentSkillsDir),
          },
          null,
          2,
        ),
      };
    },
  };
}
