/**
 * RedisAgentRegistry — distributed AgentRegistry backed by Redis.
 *
 * Liveness model: TTL + heartbeat (Consul/etcd-style service discovery).
 *   - Each card is written to its own key `${prefix}:registry:agent:<name>`
 *     with a PX expiry, so a crashed process's cards self-evict once their
 *     TTL lapses — `findByCapability` never routes to a dead agent.
 *   - A single background interval refreshes the TTL of the cards THIS process
 *     registered (the `owned` set). It never touches another process's keys,
 *     which is exactly what keeps a dead peer's agents from being kept alive.
 *   - If an owned key is found missing during a heartbeat (eviction / blip),
 *     it is re-written from the owned snapshot (self-heal).
 *
 * Read path is read-through (R1): get/list/find hit Redis directly, so there is
 * no staleness. Capabilities and (wildcard) subscriptions can't be pure key
 * lookups, so list() loads all cards and filters in-process — same matching the
 * in-memory registry does, just over Redis.
 *
 * This package stays free of any build-time Redis SDK dependency: the client is
 * injected (the factory lazy-imports ioredis). `RegistryRedisLike` is the
 * minimal structural surface we use; ioredis satisfies it.
 */

import type { AgentCard, AgentLogger, AgentRegistry, TopicString } from '@dongkseo/contracts';
import { matchTopic } from '@dongkseo/contracts';

/** Minimal Redis command surface the registry depends on. ioredis satisfies it. */
export interface RegistryRedisLike {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  pexpire(key: string, ttlMs: number): Promise<number>;
  scan(
    cursor: string,
    matchOpt: 'MATCH',
    pattern: string,
    countOpt: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  quit?(): Promise<unknown> | unknown;
}

export interface RedisAgentRegistryOptions {
  /** Redis client (injected — the factory builds one from a URL via ioredis). */
  client: RegistryRedisLike;
  /** Key prefix. Default 'nexora'. */
  prefix?: string;
  /** Card TTL in ms. Default 30_000. */
  ttlMs?: number;
  /** Heartbeat interval in ms. Default ttlMs/3 (min 1). */
  heartbeatMs?: number;
  /** Logger for heartbeat errors. Default no-op. */
  logger?: AgentLogger;
}

const NOOP_LOGGER: AgentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

const SCAN_COUNT = 100;

export class RedisAgentRegistry implements AgentRegistry {
  private readonly client: RegistryRedisLike;
  private readonly keyPrefix: string;
  readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly logger: AgentLogger;

  /** Cards THIS process registered — the only ones the heartbeat refreshes. */
  private readonly owned = new Map<string, AgentCard>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RedisAgentRegistryOptions) {
    this.client = options.client;
    this.keyPrefix = `${options.prefix ?? 'nexora'}:registry:agent:`;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(this.ttlMs / 3));
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  private key(name: string): string {
    return this.keyPrefix + name;
  }

  async register(card: AgentCard): Promise<void> {
    await this.client.set(this.key(card.name), JSON.stringify(card), 'PX', this.ttlMs);
    this.owned.set(card.name, card);
    this.ensureHeartbeat();
  }

  async unregister(name: string): Promise<void> {
    await this.client.del(this.key(name));
    this.owned.delete(name);
    if (this.owned.size === 0) this.stopHeartbeat();
  }

  async get(name: string): Promise<AgentCard | null> {
    return parseCard(await this.client.get(this.key(name)));
  }

  async list(): Promise<AgentCard[]> {
    const keys = await this.scanKeys();
    if (keys.length === 0) return [];
    const raws = await this.client.mget(...keys);
    const cards: AgentCard[] = [];
    for (const raw of raws) {
      const card = parseCard(raw);
      if (card) cards.push(card);
    }
    return cards;
  }

  async findByCapability(capability: string): Promise<AgentCard[]> {
    return (await this.list()).filter((c) => c.capabilities.includes(capability));
  }

  async findBySubscription(topic: string): Promise<AgentCard[]> {
    return (await this.list()).filter((c) =>
      c.subscribes.some((pattern) => matchTopic(pattern, topic as TopicString)),
    );
  }

  /** Stop the heartbeat and gracefully deregister this process's cards. */
  async close(): Promise<void> {
    this.stopHeartbeat();
    const names = Array.from(this.owned.keys());
    this.owned.clear();
    await Promise.all(names.map((name) => this.client.del(this.key(name)).catch(() => {})));
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async scanKeys(): Promise<string[]> {
    const pattern = `${this.keyPrefix}*`;
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    return keys;
  }

  private ensureHeartbeat(): void {
    if (this.timer || this.owned.size === 0) return;
    this.timer = setInterval(() => void this.beat(), this.heartbeatMs);
    this.timer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Refresh the TTL of every owned card; re-write any that have been evicted. */
  private async beat(): Promise<void> {
    for (const [name, card] of this.owned) {
      try {
        const refreshed = await this.client.pexpire(this.key(name), this.ttlMs);
        if (refreshed === 0) {
          await this.client.set(this.key(name), JSON.stringify(card), 'PX', this.ttlMs);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`registry.heartbeat ${name}`, { message });
      }
    }
  }
}

function parseCard(raw: string | null): AgentCard | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentCard;
  } catch {
    return null;
  }
}
