# @dongkseo/skills

**Stability: stable** · `pnpm add @dongkseo/skills`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

에이전트의 **스킬(절차적 지식)** 을 다루는 패키지다. 스킬은 *YAML frontmatter + Markdown 본문* 파일로,
에이전트가 런타임에 **발견·검색·프롬프트 주입·자동 생성** 한다. 디스크에서 파싱하고, 메모리에 담고,
질의에 맞게 골라 프롬프트용 XML로 포맷하는 것까지가 책임이다.

- ✅ 담는 것: SKILL.md 파싱(`parseSkillFile`/`loadSkills`), 적격성 필터(`filterEligibleSkills`), 인메모리 레지스트리(`SkillRegistry`), 프롬프트용 메뉴 빌드(`buildSkillMenu`), 성공한 작업에서 스킬 자동 생성(`SkillCreator`)
- ❌ 안 담는 것: 스킬 *실행* 엔진, LLM 호출, 도구 디스패치, 영속 저장소 — 그건 `core`/`tools`/`store-*` 몫
- ❌ `packages/context`의 `SkillLoader`(시스템 프롬프트용 별도 클래스)와 혼동하지 말 것 — 여기 export와 무관

의존 방향은 **다른 패키지 → skills** 단방향. skills는 `@dongkseo/contracts` 타입에만 의존한다.

## 핵심 개념

| 개념 | 무엇 | 대표 export |
| --- | --- | --- |
| **Skill** | 파싱된 스킬 한 개(`meta` frontmatter + `body` 본문 + `src` 경로) | `Skill`, `SkillFrontmatter`, `SkillMatch` |
| **Loader** | 디스크의 SKILL.md → `Skill[]` 파싱·로드 | `parseSkillFile`, `loadSkills`, `loadSkillsFromDir`, `defaultSkillSources` |
| **Eligibility** | 플랫폼·도구·env·binary 조건으로 적격 스킬만 추림 | `filterEligibleSkills`, `SkillEligibilityContext`, `CachedSkillLoader` |
| **Registry** | 인메모리 등록·태그/질의 검색·프롬프트 포맷 | `SkillRegistry` |
| **Creator** | 성공한 작업 기록에서 새 스킬 파일 자동 생성 | `SkillCreator`, `CreateSkillInput` |
| **Menu** | 적격 스킬을 `<available_skills>` XML 메뉴로 빌드(+캐시) | `buildSkillMenu`, `BuildSkillMenuOptions`, `snapshotSkills` |
| **Postprocess** | 주입 직전 스킬 본문 후처리 | `postProcessSkillBody` |

## 사용 레시피

### 디스크에서 로드해 레지스트리로 검색

```ts
import { loadSkills, defaultSkillSources, SkillRegistry } from '@dongkseo/skills';

const skills = await loadSkills(...defaultSkillSources(process.cwd()));

const registry = new SkillRegistry();
registry.registerAll(skills);

const hits = registry.search('코드 리뷰', 5);            // SkillMatch[] (score 내림차순)
const prompt = registry.formatManyForPrompt(hits.map(h => h.skill));  // <skills>…</skills>
```

### 프롬프트용 스킬 메뉴 빌드 (적격성 필터 포함)

```ts
import { buildSkillMenu, snapshotSkills, invalidateSkillMenuCache } from '@dongkseo/skills';

const menu = buildSkillMenu({
  agentSkillsDir: '/path/to/agent/skills',
  sharedSkillsDir: '/path/to/shared/skills',   // 선택
  filter: { platform: process.platform, availableTools: new Set(['bash']) },
  cacheScope: 'coder',                          // 같은 디렉토리라도 안내문구가 다르면 분리 캐시
});
// → "<available_skills> … </available_skills>" (빈 결과면 "")

const current = snapshotSkills(agentDir, sharedDir);  // 현재 스냅샷
invalidateSkillMenuCache();                            // 스킬 파일 변경 후 캐시 무효화
```

### 성공한 작업에서 스킬 자동 생성

```ts
import { SkillCreator } from '@dongkseo/skills';

const creator = new SkillCreator({ outputDir: '/path/to/agent/skills' });
const skill = await creator.create({
  taskDescription: 'PR diff를 받아 리뷰 코멘트를 단다',
  steps: ['diff 읽기', '버그 후보 찾기', '코멘트 작성'],
  toolsUsed: ['bash', 'read'],
  tags: ['review', 'git'],
  // name 생략 시 taskDescription에서 자동 생성
});
```

## API 표면 (소스 안 열고 타입만)

`index.ts`는 도메인별로 그룹핑돼 있고 파일 맨 위에 **섹션 맵 주석**이 있다. 정확한 시그니처가 필요하면
구현 본문 대신 **signatures 모드**로만 읽어라:

```
ctx_read(path="packages/skills/src/types.ts",          mode="signatures")
ctx_read(path="packages/skills/src/skill-loader.ts",   mode="signatures")
ctx_read(path="packages/skills/src/skill-registry.ts", mode="signatures")
ctx_read(path="packages/skills/src/skill-menu.ts",     mode="signatures")
ctx_read(path="packages/skills/src/index.ts",          mode="map")   # 전체 export 목록
```

어떤 파일에 뭐가 있는지는 `src/index.ts` 상단 주석 맵을 먼저 보면 된다.

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd pkgs/skills && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
