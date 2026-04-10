/**
 * CronScheduler — 단순 in-memory 스케줄러.
 *
 * Cron 표현식을 직접 파싱하지 않고 `node-cron` 같은 라이브러리를 끌어오지 않는다.
 * 대신 `intervalMs` 또는 사용자가 주입한 `nextRunAt` 함수를 사용.
 *
 * 외부 cron 라이브러리와 통합하고 싶다면:
 *   - 외부 라이브러리에서 트리거 → CronScheduler.trigger(jobId) 호출
 *   - 또는 nextRunAt() 함수에 cron 라이브러리의 다음 실행 시각 계산을 위임
 */

import type { AgentLogger } from '@nexora/contracts';

export interface CronJob {
  /** 작업 ID */
  id: string;
  /** 다음 실행 시각 계산 함수 (현재 시각 받아 다음 시각 ms 반환) */
  nextRunAt(now: number): number;
  /** 실행 함수 */
  run(): Promise<void> | void;
  /** one-shot (기본 false) */
  oneShot?: boolean;
}

export interface CronSchedulerOptions {
  logger?: AgentLogger;
}

const NOOP_LOGGER: AgentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

interface ScheduledEntry {
  job: CronJob;
  timer: ReturnType<typeof setTimeout>;
}

export class CronScheduler {
  private readonly entries = new Map<string, ScheduledEntry>();
  private readonly logger: AgentLogger;
  private stopped = false;

  constructor(options: CronSchedulerOptions = {}) {
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** 작업 등록 (이미 있으면 교체) */
  schedule(job: CronJob): void {
    if (this.stopped) throw new Error('CronScheduler is stopped');
    const existing = this.entries.get(job.id);
    if (existing) clearTimeout(existing.timer);
    this.arm(job);
  }

  /** 작업 제거 */
  unschedule(jobId: string): boolean {
    const entry = this.entries.get(jobId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(jobId);
    return true;
  }

  /** 작업 강제 즉시 실행 (스케줄 무관) */
  async trigger(jobId: string): Promise<void> {
    const entry = this.entries.get(jobId);
    if (!entry) throw new Error(`Unknown cron job: ${jobId}`);
    await this.runJob(entry.job);
  }

  /** 등록된 모든 작업 ID */
  list(): string[] {
    return Array.from(this.entries.keys());
  }

  /** 모든 타이머 정리 */
  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }

  private arm(job: CronJob): void {
    const now = Date.now();
    const nextAt = job.nextRunAt(now);
    const delay = Math.max(nextAt - now, 0);

    const timer = setTimeout(() => {
      void this.runJob(job).then(() => {
        if (this.stopped || job.oneShot) return;
        if (!this.entries.has(job.id)) return;
        this.arm(job);
      });
    }, delay);
    timer.unref?.();

    this.entries.set(job.id, { job, timer });
  }

  private async runJob(job: CronJob): Promise<void> {
    try {
      this.logger.info(`cron.run ${job.id}`);
      await job.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`cron.error ${job.id}`, { message });
    } finally {
      if (job.oneShot) this.entries.delete(job.id);
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

/** 고정 간격 cron 헬퍼 */
export function intervalJob(
  id: string,
  intervalMs: number,
  run: () => Promise<void> | void,
): CronJob {
  return {
    id,
    nextRunAt: (now) => now + intervalMs,
    run,
  };
}

/** 한 번만 실행하는 헬퍼 */
export function oneShotJob(
  id: string,
  delayMs: number,
  run: () => Promise<void> | void,
): CronJob {
  return {
    id,
    nextRunAt: (now) => now + delayMs,
    run,
    oneShot: true,
  };
}
