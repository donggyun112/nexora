# @dongkseo/adapters

**Stability: stable** · `pnpm add @dongkseo/adapters`

> 이 파일은 에이전트(사람·LLM)가 **소스를 열지 않고도** 이 패키지를 쓸 수 있게 하는 오리엔테이션 문서다.
> 정확한 API 타입은 "API 표면" 섹션의 방법으로 `signatures`만 읽어라 — 본문을 베끼지 말 것.

## 무엇인가 / 무엇이 아닌가

외부 채널(HTTP·Discord·Slack·이슈 트래커)과 Nexora의 `MessageRouter` 사이를 잇는 **경계 어댑터** 패키지다.
들어오는 채널 이벤트를 `InboundMessage`로 정규화해 라우터에 넣고, 라우터가 내는 `OutboundChunk`를
다시 각 채널 형식으로 돌려보낸다. LLM 실행·라우팅 로직 자체는 담지 않는다.

- ✅ 담는 것: 채널 어댑터(`HttpAdapter`, `DiscordAdapter`, `SlackAdapter`, `PaperclipAdapter`), Discord 보조 브리지(승인·리포트·리액션·봇 부트스트랩), 세션 키 빌더, 외부 LLM 제공자 API 키 회전 헬퍼(`resolveAnthropicApiKey`, `resolveCodexApiKey`)
- ❌ 안 담는 것: 메시지 라우팅/에이전트 실행(그건 `core`/`fleet`), 타입 계약(`contracts`), 저장소 구현(`store-*`)

의존 방향은 **adapters → contracts/core(라우터 타입)** 단방향. 또한 **SDK 비의존** 원칙: `discord.js`,
Slack SDK 등은 dependency가 아니며 호출자가 자신의 client를 주입한다(버전 고정 자유).

## 핵심 개념

| 개념 | 무엇 | 대표 export |
|------|------|-------------|
| **HTTP 어댑터** | REST 엔드포인트로 메시지 수신/스트리밍 (node:http, Express 없음) | `HttpAdapter`, `HttpAdapterOptions` |
| **Discord 어댑터** | Discord 메시지 ↔ 라우터 (client 주입형) | `DiscordAdapter`, `renderDiscordArtifactMessages` |
| **Discord 봇 부트** | 멀티에이전트 팀을 Discord 봇으로 한 번에 기동 | `startDiscordBot`, `RunningDiscordBot` |
| **Discord 브리지** | 승인 버튼·리포트 게시·상태 리액션 보조 | `bridgeDiscordApprovals`, `bridgeDiscordReports`, `createStatusReactionController` |
| **Slack 어댑터** | Slack 이벤트 ↔ 라우터 (client 주입형) | `SlackAdapter`, `SlackAdapterOptions` |
| **Paperclip 어댑터** | 외부 이슈 트래커 폴링→메시지 | `PaperclipAdapter`, `PaperclipAdapterOptions` |
| **세션 키** | 채널/스레드 → 안정적 세션 식별자 | `buildSessionKey`, `isSharedSession` |
| **제공자 인증** | Claude/Codex API 키 자동 회전 | `resolveAnthropicApiKey`, `resolveCodexApiKey` |

## 사용 레시피

HTTP로 라우터를 노출한다 (`examples/auto-work-flow` 기준, 실제 동작 코드):

```ts
import { HttpAdapter } from '@dongkseo/adapters';

const http = new HttpAdapter({
  port: Number(process.env.PORT ?? 3000),
  host: '0.0.0.0',
  resolveTenant: () => 'default',
});

await http.start(router);        // router: MessageRouter
console.log(`listening on ${http.port()}`);
// curl localhost:3000/messages -d '{"content":"hello"}'
// 스트리밍은 /stream 엔드포인트 (SSE)
```

Discord에 붙인다 (SDK 비의존 — discord.js Client를 직접 주입):

```ts
import { Client, GatewayIntentBits } from 'discord.js';
import { DiscordAdapter } from '@dongkseo/adapters';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
await client.login(process.env.DISCORD_TOKEN);

const adapter = new DiscordAdapter({ client, resolveTenant: (guildId) => guildId });
await adapter.start(router);
```

멀티에이전트 팀을 Discord 봇 하나로 기동한다:

```ts
import { startDiscordBot } from '@dongkseo/adapters';

const bot = await startDiscordBot({
  team,                              // 에이전트 팀(라우터 구성)
  groupTopic: 'group.requested',     // @mention 없을 때 그룹 채팅 topic
  requireMention: true,              // 서버 채널은 @mention 필요
});
// 종료 시: await bot.stop?.()  ── RunningDiscordBot 시그니처는 signatures로 확인
```

LLM 제공자 키를 회전한다 (구독 OAuth/JWT 만료 시 자동 갱신):

```ts
import { resolveAnthropicApiKey, resolveCodexApiKey } from '@dongkseo/adapters';

const anthropicKey = await resolveAnthropicApiKey();   // Claude 구독 OAuth 토큰 회전
const codexKey = await resolveCodexApiKey();           // Codex JWT 만료 검사 후 회전
```

더 큰 예제: [`examples/auto-work-flow`](../../examples/auto-work-flow), [`examples/personal-assistant`](../../examples/personal-assistant), [`examples/helpdesk`](../../examples/helpdesk).

## API 표면 (소스 안 열고 타입만)

전체 export 목록(위치 맵):

```bash
ctx_read packages/adapters/src/index.ts --mode map
```

개별 모듈 타입만 (본문 베끼지 말고 signatures로):

```bash
ctx_read packages/adapters/src/http.ts            --mode signatures   # HttpAdapter, HttpAdapterOptions
ctx_read packages/adapters/src/discord.ts         --mode signatures   # DiscordAdapter
ctx_read packages/adapters/src/discord-bot.ts     --mode signatures   # startDiscordBot, RunningDiscordBot
ctx_read packages/adapters/src/slack.ts           --mode signatures   # SlackAdapter
ctx_read packages/adapters/src/paperclip.ts       --mode signatures   # PaperclipAdapter
ctx_read packages/adapters/src/session-key.ts     --mode signatures   # buildSessionKey, isSharedSession
ctx_read packages/adapters/src/anthropic-auth.ts  --mode signatures   # resolveAnthropicApiKey
ctx_read packages/adapters/src/codex-auth.ts      --mode signatures   # resolveCodexApiKey
```

## 유지보수 (drift 방지)

- 이 README = **목적·개념·레시피** 만. 거의 안 변하므로 손으로 관리.
- **API 정본은 각 소스의 TSDoc** (`/** … */`). API가 바뀌면 코드 옆 TSDoc만 고치면 됨 — 여기 표는 복제하지 말 것.
- 새 모듈을 export하면 `index.ts` 상단 섹션 맵에 한 줄만 추가.

## Tests

```bash
cd packages/adapters && pnpm test
```

Part of the [Nexora](../../README.md) multi-tenant agent framework. · [Package map](../../docs/architecture/packages-map.md)
