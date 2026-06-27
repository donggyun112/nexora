/**
 * KeyedSerializer — key 단위로 async generator 소비를 직렬화하는 single-writer 락.
 *
 * repo 전역의 per-key promise-chain 관용구(thread-agent-driver `threadRuns`,
 * thread-adapter `mainRuns`, conversation-memory `appendChainByChannel`)를
 * async generator 로 확장한 것. 같은 key 의 다음 turn 은 현재 turn 의 소비가
 * 끝나거나(또는 abort/early-break) 될 때까지 첫 이벤트를 만들지 않는다.
 *
 * marketing-manager 처럼 한 conversationId 를 여러 드라이버(gateway/web +
 * bootstrapAgent `.completed`)가 구동하는 에이전트의 turn 을 묶어, ReAct 루프가
 * interleave 되지 않도록 보장한다.
 */
export class KeyedSerializer {
  private readonly chains = new Map<string, Promise<void>>();

  /** key 단위로 generator 소비를 직렬화. 락은 소비 완료/중단까지 유지된다. */
  async *serialize<E>(key: string, make: () => AsyncGenerator<E>): AsyncGenerator<E> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    // prev 가 실패해도 settle 후 우리 차례가 오도록 양쪽 모두 done 으로 연결.
    const tail = prev.then(() => done, () => done);
    this.chains.set(key, tail);
    await prev.catch(() => {});
    try {
      yield* make();
    } finally {
      release();
      // 우리가 마지막 holder 면 GC. 뒤에 누가 붙었으면 그대로 둔다.
      if (this.chains.get(key) === tail) this.chains.delete(key);
    }
  }

  /**
   * key 단위로 critical section(read-modify-write 등)을 직렬화하는 Promise 변종.
   * 같은 key 의 다음 호출은 현재 fn 이 settle(성공/실패)될 때까지 시작하지 않는다.
   * 서로 다른 key 는 병렬로 진행. atomic rename 으로는 못 막는 lost-update 를,
   * read+write 전체를 같은 key(리소스 경로)로 묶어 방지하는 용도.
   */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    // prev 가 실패해도 settle 후 우리 차례가 오도록 양쪽 모두 done 으로 연결.
    const tail = prev.then(() => done, () => done);
    this.chains.set(key, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      // 우리가 마지막 holder 면 GC. 뒤에 누가 붙었으면 그대로 둔다.
      if (this.chains.get(key) === tail) this.chains.delete(key);
    }
  }
}
