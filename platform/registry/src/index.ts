/**
 * @nexora/registry — AgentCard 등록/조회.
 *
 * 인메모리 기본 구현 + AgentRegistry 인터페이스.
 * 분산 환경에서는 Redis/etcd 백엔드로 교체 가능.
 */

import type { AgentCard, TopicString } from '@nexora/contracts';
import { matchTopic } from '@nexora/contracts';

export interface AgentRegistry {
  register(card: AgentCard): Promise<void>;
  unregister(name: string): Promise<void>;
  get(name: string): Promise<AgentCard | null>;
  list(): Promise<AgentCard[]>;
  /** 특정 capability를 가진 에이전트 조회 */
  findByCapability(capability: string): Promise<AgentCard[]>;
  /** 특정 topic을 구독하는 에이전트 조회 */
  findBySubscription(topic: string): Promise<AgentCard[]>;
}

export class InMemoryAgentRegistry implements AgentRegistry {
  private readonly cards = new Map<string, AgentCard>();

  async register(card: AgentCard): Promise<void> {
    this.cards.set(card.name, card);
  }

  async unregister(name: string): Promise<void> {
    this.cards.delete(name);
  }

  async get(name: string): Promise<AgentCard | null> {
    return this.cards.get(name) ?? null;
  }

  async list(): Promise<AgentCard[]> {
    return Array.from(this.cards.values());
  }

  async findByCapability(capability: string): Promise<AgentCard[]> {
    return Array.from(this.cards.values()).filter(c => c.capabilities.includes(capability));
  }

  async findBySubscription(topic: string): Promise<AgentCard[]> {
    return Array.from(this.cards.values()).filter(c =>
      c.subscribes.some(pattern => matchTopic(pattern, topic as TopicString)),
    );
  }
}
