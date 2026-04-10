/**
 * Store 팩토리 — 설정 기반 store 구현체 생성.
 *
 * 현재는 'json' 타입만 지원, 향후 'mongo', 'postgres' 등 추가.
 */

import type {
  ConversationStore,
  KnowledgeStore,
  ScheduleStore,
  ContextStore,
  AuditStore,
  ToolContextStore,
} from '@nexora/contracts';

export interface StoreProvider {
  conversation: ConversationStore;
  knowledge: KnowledgeStore;
  schedule: ScheduleStore;
  context: ContextStore;
  audit: AuditStore;
  toolContext: ToolContextStore;
}

export interface StoreConfig {
  type: 'json';
  /** 데이터 루트 디렉토리 (json 타입에서 사용) */
  dataDir: string;
}

/**
 * 설정 기반으로 StoreProvider 생성.
 *
 * store-json 패키지를 동적 import하여 구현체를 로드.
 * 패키지 간 하드 의존성 없이 런타임에 연결.
 */
export async function createStoreProvider(config: StoreConfig): Promise<StoreProvider> {
  switch (config.type) {
    case 'json': {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mod: { createJsonStoreProvider: (dataDir: string) => StoreProvider } =
        await (import('@nexora/store-json' as string) as Promise<{ createJsonStoreProvider: (dataDir: string) => StoreProvider }>);
      return mod.createJsonStoreProvider(config.dataDir);
    }
    default:
      throw new Error(`Unknown store type: ${String((config as StoreConfig).type)}`);
  }
}
