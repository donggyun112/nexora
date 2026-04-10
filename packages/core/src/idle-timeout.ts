/**
 * Idle Timeout — 일정 시간 활동이 없으면 abort.
 *
 * 참고: reference idle-timeout.ts.
 * 모든 활동 시점에 reset() 호출, 일정 시간 동안 reset이 없으면 onTimeout 발화.
 */

export class IdleTimeoutError extends Error {
  constructor(message = 'Agent idle timeout exceeded') {
    super(message);
    this.name = 'IdleTimeoutError';
  }
}

export interface IdleTimeout {
  /** 활동 시점에 호출 */
  reset(): void;
  /** 타이머 제거 */
  clear(): void;
}

/**
 * idleMs 만큼 활동이 없으면 onTimeout 호출.
 *
 * AgentRunner는 onTimeout 콜백에서 AbortController.abort()를 호출하여
 * in-flight LLM/도구 호출을 취소하고, signal을 통해 architecture loop를 종료시킨다.
 */
export function createIdleTimeout(idleMs: number, onTimeout: () => void): IdleTimeout {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cleared = false;

  const arm = (): void => {
    if (cleared) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (cleared) return;
      onTimeout();
    }, idleMs);
    timer.unref?.();
  };

  arm();

  return {
    reset: arm,
    clear: () => {
      cleared = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
