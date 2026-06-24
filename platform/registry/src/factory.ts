// ─── createAgentRegistry: config 기반 registry 팩토리 ──────────────────────
//
// createTransport와 대칭인 composition 헬퍼다. 엔트리포인트가 registry 구현체
// 선택 로직을 매번 재작성하지 않도록 모아둔다. 이 패키지는 프레임워크 레이어
// 이므로 process.env를 읽지 않는다 — 모든 설정은 호출자가 명시적으로 주입한다
// (env/플래그/파일 해석은 엔트리포인트의 책임). Redis 클라이언트는 ioredis를
// 지연 import하여 만들기 때문에 registry 패키지는 빌드 타임에 Redis SDK 의존이
// 0이다. ioredis는 OPTIONAL peer dependency로, kind='redis'일 때만 필요하다.
//
// 반환된 close()는 registry teardown(heartbeat 정지 + graceful deregister)과
// 팩토리가 연 Redis 커넥션 정리를 함께 처리한다.

import type { AgentLogger, AgentRegistry } from '@dongkseo/contracts';
import { InMemoryAgentRegistry } from './index.js';
import { RedisAgentRegistry, type RegistryRedisLike } from './redis.js';

export type RegistryKind = 'memory' | 'redis';

export interface CreateRegistryOptions {
  /** registry 구현체 선택. 생략 시 'memory'. */
  kind?: RegistryKind;
  /** Redis 접속 URL. kind='redis'에 필수(redisClient를 주지 않은 경우). */
  redisUrl?: string;
  /** 키 prefix. 생략 시 'nexora'. */
  prefix?: string;
  /** 카드 TTL(ms). 생략 시 RedisAgentRegistry 기본값(30s). */
  ttlMs?: number;
  /** heartbeat 주기(ms). 생략 시 ttlMs/3. */
  heartbeatMs?: number;
  /** heartbeat 에러 로거. */
  logger?: AgentLogger;
  /**
   * ioredis 대신 직접 만든 Redis 클라이언트를 주입한다(테스트/커스텀 풀링용).
   * 주면 지연 import를 건너뛴다. 팩토리가 만들지 않았으므로 close()는 이
   * 클라이언트를 닫지 않는다.
   */
  redisClient?: RegistryRedisLike;
}

export interface RegistryDescription {
  /** Implementation identifier: 'memory' | 'redis'. */
  kind: string;
  /** Whether entries are visible across processes. */
  distributed: boolean;
  /** Card TTL in ms (redis only). */
  ttlMs?: number;
  notes?: string;
}

export interface CreatedRegistry {
  registry: AgentRegistry;
  description: RegistryDescription;
  /** registry teardown + 팩토리가 연 Redis 커넥션을 닫는다. */
  close(): Promise<void>;
}

type IoredisCtor = new (url: string) => RegistryRedisLike;

async function loadIoredis(): Promise<IoredisCtor> {
  try {
    // 타입을 지운 지연 import — registry 패키지가 빌드 타임에 ioredis 타입을
    // 요구하지 않도록 한다. ioredis는 클라이언트를 default export로 노출한다.
    const mod = await import('ioredis' as string) as { default?: IoredisCtor } & IoredisCtor;
    return (mod.default ?? mod) as IoredisCtor;
  } catch {
    throw new Error(
      `Registry requires Redis but 'ioredis' is not installed. ` +
      `Install it where the entrypoint runs:  pnpm add ioredis`,
    );
  }
}

/** quit가 있으면 best-effort로 닫는다(에러 무시). */
async function closeClient(client: { quit?(): Promise<unknown> | unknown }): Promise<void> {
  try {
    await client.quit?.();
  } catch {
    /* best-effort */
  }
}

export async function createAgentRegistry(
  options: CreateRegistryOptions = {},
): Promise<CreatedRegistry> {
  const kind = options.kind ?? 'memory';

  if (kind === 'memory') {
    return {
      registry: new InMemoryAgentRegistry(),
      description: { kind: 'memory', distributed: false },
      close: async () => {},
    };
  }

  // 클라이언트 출처 결정: 주입된 것 우선, 없으면 redisUrl로 ioredis 생성.
  let client: RegistryRedisLike;
  let ownsClient: boolean;

  if (options.redisClient) {
    client = options.redisClient;
    ownsClient = false; // 호출자가 소유 — close()에서 닫지 않는다
  } else {
    if (!options.redisUrl) {
      throw new Error(
        `Registry kind "redis" requires a Redis URL. ` +
        `Pass options.redisUrl or options.redisClient.`,
      );
    }
    const Redis = await loadIoredis();
    client = new Redis(options.redisUrl);
    ownsClient = true;
  }

  const registry = new RedisAgentRegistry({
    client,
    prefix: options.prefix,
    ttlMs: options.ttlMs,
    heartbeatMs: options.heartbeatMs,
    logger: options.logger,
  });

  return {
    registry,
    description: { kind: 'redis', distributed: true, ttlMs: registry.ttlMs },
    close: async () => {
      await registry.close();
      if (ownsClient) await closeClient(client);
    },
  };
}
