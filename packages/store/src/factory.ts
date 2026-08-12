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
  ArtifactChannel,
  TreeConversationStore,
  SuspendedTurnStore,
  TranscriptStore,
  WorkspaceStateStore,
  DescribableStore,
  StoreBackendInfo,
  AgentLogger,
  EffectLedger,
  RuntimeInputQueue,
} from '@dongkseo/contracts';

export interface StoreProvider {
  conversation: ConversationStore;
  knowledge: KnowledgeStore;
  schedule: ScheduleStore;
  context: ContextStore;
  audit: AuditStore;
  toolContext: ToolContextStore;
  /** 에이전트 간 산출물 공유 채널 (conversationId 키). */
  artifact: ArtifactChannel;
  /** Suspended-turn store — parks handraise(human) turns until the answer arrives. */
  suspendedTurn: SuspendedTurnStore;
  /** Session tree store (optional — only available with PG backend or store-json) */
  sessionTree?: TreeConversationStore;
  /** Rich append-only transcript store (system of record). Optional until all backends implement it. */
  transcript?: TranscriptStore;
  /** 대화별 워크스페이스 snapshot 바인딩 (conversationId 키). Optional until all backends implement it. */
  workspaceState?: WorkspaceStateStore;
  /** Durable tool-effect intent/results and run lease. Optional for legacy/custom backends. */
  effectLedger?: EffectLedger;
  /** Ordered durable inbox. The built-in backends share storage with effectLedger. */
  inputQueue?: RuntimeInputQueue;
}

/**
 * Check all stores in the provider for dev-only backends and log warnings.
 * Call this at bootstrap time so operators notice before going to production.
 */
export function warnDevStores(
  provider: StoreProvider,
  logger: AgentLogger,
): void {
  const stores: [string, unknown][] = [
    ['conversation', provider.conversation],
    ['knowledge', provider.knowledge],
    ['schedule', provider.schedule],
    ['context', provider.context],
    ['audit', provider.audit],
    ['toolContext', provider.toolContext],
    ['artifact', provider.artifact],
    ['workspaceState', provider.workspaceState],
    ['effectLedger', provider.effectLedger],
    ['inputQueue', provider.inputQueue],
  ];
  for (const [name, store] of stores) {
    if (isDescribable(store)) {
      const info = store.describeBackend();
      if (info.type === 'dev') {
        logger.warn(
          `Store "${name}" uses dev-only backend "${info.name}" ` +
          `(durable=${info.durable}, multiProcess=${info.multiProcess}). ` +
          `Not recommended for production.`,
        );
      }
    }
  }
}

function isDescribable(store: unknown): store is DescribableStore {
  return (
    store !== null &&
    typeof store === 'object' &&
    'describeBackend' in store &&
    typeof (store as DescribableStore).describeBackend === 'function'
  );
}

export type StoreConfig =
  | { type: 'json'; dataDir: string }
  | { type: 'pg'; connectionString: string };

/**
 * 설정 기반으로 StoreProvider 생성.
 *
 * store-json 패키지를 동적 import하여 구현체를 로드.
 * 패키지 간 하드 의존성 없이 런타임에 연결.
 */
export async function createStoreProvider(config: StoreConfig): Promise<StoreProvider> {
  switch (config.type) {
    case 'json': {
      const mod: { createJsonStoreProvider: (dataDir: string) => StoreProvider } =
        await (import('@dongkseo/store-json' as string) as Promise<{ createJsonStoreProvider: (dataDir: string) => StoreProvider }>);
      return mod.createJsonStoreProvider(config.dataDir);
    }
    case 'pg': {
      const mod: {
        createPgClient: (opts: { connectionString: string }) => Promise<{ sql: unknown }>;
        createPgStoreProvider: (sql: unknown) => StoreProvider;
        TreeConversationStorePg: new (sql: unknown) => TreeConversationStore;
      } = await (import('@dongkseo/store-pg' as string) as Promise<{
        createPgClient: (opts: { connectionString: string }) => Promise<{ sql: unknown }>;
        createPgStoreProvider: (sql: unknown) => StoreProvider;
        TreeConversationStorePg: new (sql: unknown) => TreeConversationStore;
      }>);
      const { sql } = await mod.createPgClient({ connectionString: config.connectionString });
      const provider = mod.createPgStoreProvider(sql);
      return { ...provider, sessionTree: new mod.TreeConversationStorePg(sql) };
    }
    default:
      throw new Error(`Unknown store type: ${String((config as { type: string }).type)}`);
  }
}
