/**
 * ContinuousWorkspaceProvider — turn 경계를 넘어 워크스페이스를 연속시키는 데코레이터.
 *
 * 하네스가 보는 `WorkspaceProvider`를 구현하되, inner로 resume을 보유한 sandbox
 * 클라이언트(예: AsrtSandboxClient)를 감싼다. `acquire()`는 conversationId로
 * 직전 snapshot을 로드해 `resume()`(없거나 실패하면 `acquire()`)하고, 반환 세션의
 * `cleanup()`을 snapshot+persist로 래핑한다. 하네스/bootstrap은 데코레이터인지
 * raw provider인지 모른다(완전 투명).
 *
 * best-effort: snapshot persist/load 실패는 로그 후 swallow — 가용성 > 무결성
 * (설계 §7). 같은 conversationId의 턴은 직렬화된다고 가정(설계 §7 동시성).
 *
 * 설계: docs/superpowers/specs/2026-06-25-workspace-continuity-design.md §6
 */

import type {
  WorkspaceProvider,
  WorkspaceSession,
  WorkspaceAcquireOptions,
  WorkspaceSnapshot,
  WorkspaceStateStore,
} from '@dongkseo/contracts';

/** inner는 fresh acquire + snapshot resume 둘 다 할 수 있어야 한다. */
export interface ResumableWorkspaceProvider extends WorkspaceProvider {
  resume(state: WorkspaceSnapshot): Promise<WorkspaceSession>;
}

export interface ContinuousWorkspaceProviderOptions {
  /** Optional sink for best-effort failure logs. */
  onWarn?: (message: string, error: unknown) => void;
}

export class ContinuousWorkspaceProvider implements WorkspaceProvider {
  constructor(
    private readonly inner: ResumableWorkspaceProvider,
    private readonly store: WorkspaceStateStore,
    private readonly conversationId: string,
    private readonly options: ContinuousWorkspaceProviderOptions = {},
  ) {}

  async acquire(options: WorkspaceAcquireOptions = {}): Promise<WorkspaceSession> {
    let prior: WorkspaceSnapshot | null = null;
    try {
      prior = await this.store.load(this.conversationId);
    } catch (err) {
      this.warn('workspace-state load failed; acquiring fresh', err);
      prior = null;
    }

    let session: WorkspaceSession;
    if (prior) {
      try {
        session = await this.inner.resume(prior);
      } catch (err) {
        this.warn('workspace resume failed; acquiring fresh', err);
        session = await this.inner.acquire(options);
      }
    } else {
      session = await this.inner.acquire(options);
    }
    return this.wrapCleanup(session);
  }

  private wrapCleanup(session: WorkspaceSession): WorkspaceSession {
    const origCleanup = session.cleanup.bind(session);
    const snapshotFn = session.snapshot?.bind(session);
    const store = this.store;
    const conversationId = this.conversationId;
    const warn = this.warn.bind(this);

    session.cleanup = async (): Promise<void> => {
      try {
        if (snapshotFn) {
          const snap = await snapshotFn();
          if (snap) await store.save(conversationId, snap);
        }
      } catch (err) {
        warn('workspace snapshot/persist failed on cleanup', err);
      }
      await origCleanup();
    };
    return session;
  }

  private warn(message: string, error: unknown): void {
    this.options.onWarn?.(message, error);
  }
}
