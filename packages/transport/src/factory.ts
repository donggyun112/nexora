// ─── createTransport: config 기반 transport 팩토리 ─────────────────────────
//
// 엔트리포인트가 transport 구현체 선택 로직을 매번 재작성하지 않도록 모아둔
// composition 헬퍼다. 이 패키지는 프레임워크 레이어이므로 process.env를 읽지
// 않는다 — 모든 설정은 호출자가 명시적으로 주입한다(env/플래그/파일 해석은
// 엔트리포인트의 책임). Redis 클라이언트는 `ioredis`를 지연 import하여 만들기
// 때문에 transport 패키지는 빌드 타임에 Redis SDK 의존이 0이다. ioredis는
// OPTIONAL peer dependency로, redis-* kind를 선택할 때만 필요하다.
//
// 반환된 close()는 transport와 팩토리가 연 Redis 커넥션까지 정리한다 —
// 호출자는 transport.close() 대신 반드시 이 close()를 써야 소켓이 해제된다.

import type { EventTransport, TransportDescription } from '@dongkseo/contracts';
import { LocalTransport } from './local.js';
import { RedisTransport, type RedisLike } from './redis.js';
import { RedisStreamsTransport, type RedisStreamsLike } from './redis-streams.js';

export type TransportKind = 'local' | 'redis-pubsub' | 'redis-streams';

export interface CreateTransportOptions {
  /** transport 구현체 선택. 생략 시 'local'. */
  kind?: TransportKind;
  /** Redis 접속 URL. redis-* kind에 필수. */
  redisUrl?: string;
  /** 스트림/채널 키 prefix. 생략 시 'nexora'. */
  prefix?: string;
  /** redis-streams 컨슈머 이름. 생략 시 RedisStreamsTransport가 랜덤 생성. */
  consumerName?: string;
  /** 기본 request() 타임아웃(ms). */
  defaultRequestTimeoutMs?: number;
  /**
   * ioredis 대신 직접 만든 Redis 클라이언트를 주입한다(테스트/커스텀 풀링용).
   * 주면 지연 import를 건너뛰고 이 클라이언트를 쓴다. publisher/consumer는
   * 서로 다른 커넥션이어야 한다(consumer는 블로킹 read에 들어간다).
   * 팩토리가 만들지 않았으므로 close()는 이 클라이언트를 닫지 않는다.
   */
  redisClients?: { publisher: RedisLike & RedisStreamsLike; consumer: RedisLike & RedisStreamsLike };
}

export interface CreatedTransport {
  transport: EventTransport;
  description: TransportDescription;
  /** transport와 팩토리가 연 Redis 커넥션을 모두 닫는다. */
  close(): Promise<void>;
}

/** pubsub + streams 두 표면을 모두 만족하는 Redis 클라이언트. */
type IoredisClient = RedisLike & RedisStreamsLike;
type IoredisCtor = new (url: string) => IoredisClient;

async function loadIoredis(): Promise<IoredisCtor> {
  try {
    // 타입을 지운 지연 import — transport 패키지가 빌드 타임에 ioredis 타입을
    // 요구하지 않도록 한다. ioredis는 클라이언트를 default export로 노출한다.
    const mod = await import('ioredis' as string) as { default?: IoredisCtor } & IoredisCtor;
    return (mod.default ?? mod) as IoredisCtor;
  } catch {
    throw new Error(
      `Transport requires Redis but 'ioredis' is not installed. ` +
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

export async function createTransport(
  options: CreateTransportOptions = {},
): Promise<CreatedTransport> {
  const kind = options.kind ?? 'local';

  if (kind === 'local') {
    const transport = new LocalTransport({
      defaultRequestTimeoutMs: options.defaultRequestTimeoutMs,
    });
    return { transport, description: transport.describe(), close: () => transport.close() };
  }

  const prefix = options.prefix ?? 'nexora';

  // 클라이언트 출처 결정: 주입된 것 우선, 없으면 redisUrl로 ioredis 생성.
  let publisher: IoredisClient;
  let consumer: IoredisClient;
  let ownsClients: boolean;

  if (options.redisClients) {
    publisher = options.redisClients.publisher;
    consumer = options.redisClients.consumer;
    ownsClients = false; // 호출자가 소유 — close()에서 닫지 않는다
  } else {
    if (!options.redisUrl) {
      throw new Error(
        `Transport kind "${kind}" requires a Redis URL. ` +
        `Pass options.redisUrl or options.redisClients.`,
      );
    }
    const Redis = await loadIoredis();
    // pub/sub·streams 모두 consumer/subscriber는 전용 커넥션이어야 한다.
    publisher = new Redis(options.redisUrl);
    consumer = new Redis(options.redisUrl);
    ownsClients = true;
  }

  const closeOwned = async (): Promise<void> => {
    if (!ownsClients) return;
    await closeClient(publisher);
    await closeClient(consumer);
  };

  if (kind === 'redis-pubsub') {
    const transport = new RedisTransport({
      publisher,
      subscriber: consumer,
      channelPrefix: prefix,
      defaultRequestTimeoutMs: options.defaultRequestTimeoutMs,
    });
    return {
      transport,
      description: transport.describe(),
      close: async () => { await transport.close(); await closeOwned(); },
    };
  }

  // redis-streams
  const transport = new RedisStreamsTransport({
    publisher,
    consumer,
    streamPrefix: prefix,
    consumerName: options.consumerName,
    defaultRequestTimeoutMs: options.defaultRequestTimeoutMs,
  });
  return {
    transport,
    description: transport.describe(),
    close: async () => { await transport.close(); await closeOwned(); },
  };
}
