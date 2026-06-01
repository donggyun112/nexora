/**
 * Skill body 후처리 — skill_manage(load) 가 본문을 LLM 에 노출하기 직전 단계.
 *
 * 두 일을 한다:
 *   1. 템플릿 치환 — `$SKILL_DIR` 토큰을 그 스킬 디렉토리의 절대경로로 변경.
 *      Hermes preprocessing 의 `$HERMES_SKILL_DIR` 와 같은 역할 — 본문이
 *      scripts / templates 절대 경로를 깨끗하게 참조 가능.
 *   2. supporting files 안내 — 스킬이 디렉토리 형태(`<dir>/SKILL.md`) 면
 *      같은 디렉토리의 보조 파일/디렉토리를 본문 끝에 짧게 나열.
 *      flat `.md` 스킬에는 적용 안 함(디렉토리를 단독 점유하지 않음).
 *
 * inline-shell 확장(`$(cmd)`) 은 보안 risk 라 포함하지 않는다. 호출자가 별도
 * 미들웨어로 붙이면 된다 — Hermes 도 그 단계는 옵셔널.
 *
 * 트레일러 안내문구는 호출자가 옵션으로 커스터마이즈 가능(다국어 분리).
 */

import { readdirSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';

const SKILL_DIR_TOKEN = /\$SKILL_DIR\b/g;
const DEFAULT_EXCLUDED = new Set(['SKILL.md', 'README.md', 'evals', 'evals.json']);
const DEFAULT_MAX_SUPPORTING = 20;
const DEFAULT_TRAILER =
  'scripts can be executed directly. read other files with normal file tools using the absolute paths above.';

export interface PostProcessSkillOptions {
  readonly body: string;
  readonly sourcePath: string;
  /** 본문 끝 trailer 안내문구. 미지정 시 기본 영어 안내. */
  readonly trailerText?: string;
  /** supporting 디렉토리에서 제외할 항목 이름. 기본: SKILL.md / README.md / evals / evals.json. */
  readonly excludedSupporting?: ReadonlySet<string>;
  /** supporting 최대 개수. 기본 20. */
  readonly maxSupporting?: number;
}

export function postProcessSkillBody(options: PostProcessSkillOptions): string {
  const { body, sourcePath } = options;
  const skillDir = path.dirname(sourcePath);
  const baseName = path.basename(sourcePath);

  const out = body.replace(SKILL_DIR_TOKEN, skillDir);

  // flat .md 스킬은 디렉토리 단독 점유 아님 — supporting 안내 안 함.
  if (baseName !== 'SKILL.md') return out;

  const excluded = options.excludedSupporting ?? DEFAULT_EXCLUDED;
  const max = options.maxSupporting ?? DEFAULT_MAX_SUPPORTING;
  const supporting = listSupportingFiles(skillDir, excluded, max);
  if (supporting.length === 0) return out;

  const trailer = options.trailerText ?? DEFAULT_TRAILER;
  const lines = ['', '---', '', '_Supporting files (in the same skill directory):_'];
  for (const rel of supporting) {
    lines.push(`- ${rel}  →  ${path.join(skillDir, rel)}`);
  }
  lines.push('');
  lines.push(trailer);
  return `${out}\n${lines.join('\n')}\n`;
}

function listSupportingFiles(
  dir: string,
  excluded: ReadonlySet<string>,
  max: number,
): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (excluded.has(entry.name)) continue;
    if (entry.isDirectory()) {
      result.push(`${entry.name}/`);
    } else {
      try {
        const st = statSync(path.join(dir, entry.name));
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      result.push(entry.name);
    }
    if (result.length >= max) break;
  }
  result.sort();
  return result;
}
