# @dongkseo/skills

**Stability: experimental** · `pnpm add @dongkseo/skills`

Python Nexora와 동일한 progressive-disclosure 스킬 런타임이다. discovery는 metadata만 읽고,
전체 `SKILL.md` 본문은 모델이 단일 `skill` 도구를 정확한 이름으로 호출한 경우에만 로드한다.

## 핵심 계약

| 개념 | 역할 |
| --- | --- |
| `SkillMetadata` | catalog에 노출되는 name, description, revision |
| `Skill` | 호출 후에만 로드되는 body, origin, resource base, allowed tools |
| `SkillSource` | source-neutral `list()` / `load(name)` 포트 |
| `DirectorySkillSource` | 디렉터리형 `{name}/SKILL.md` 어댑터 |
| `SkillRegistry` | ordered source override와 bounded catalog 소유 |
| `SkillTools` | 기존 `ToolExecutor`에 단 하나의 lazy `skill` 도구 추가 |

시스템 프롬프트 메뉴, `skill_reload`, `skill_manage`, flat Markdown discovery는 제공하지 않는다.
변경 사항은 `registry.refresh()`로 metadata만 다시 읽는다.

## 사용

```ts
import {
  DirectorySkillSource,
  SkillRegistry,
  SkillTools,
} from '@dongkseo/skills';

const registry = new SkillRegistry([
  new DirectorySkillSource('/global/skills'),
  new DirectorySkillSource('/project/skills'), // later source wins
]);

const tools = new SkillTools(baseToolExecutor, registry);
const runner = new AgentRunner({ architecture, llm, tools });

await registry.refresh(); // optional explicit reload; bodies remain unloaded
```

`SkillTools.prepare()`가 모델 호출 직전에 metadata catalog를 준비한다. `skill` 호출 결과에는 일반
tool result와 별도로 `contextMessages`가 붙고, architecture가 이를 다음 모델 라운드에 주입한다.

리소스 경로는 본문 안의 `${NEXORA_SKILL_ROOT}` 또는 `${NEXORA_SKILL_DIR}`로 참조하고,
호출 인자는 `${ARGUMENTS}` 또는 `$ARGUMENTS`로 받는다.

## API 표면

```bash
ctx_read(path="packages/skills/src/types.ts", mode="signatures")
ctx_read(path="packages/skills/src/skill-loader.ts", mode="signatures")
ctx_read(path="packages/skills/src/skill-registry.ts", mode="signatures")
ctx_read(path="packages/skills/src/skill-tools.ts", mode="signatures")
```

## Tests

```bash
pnpm --filter @dongkseo/skills test
```
