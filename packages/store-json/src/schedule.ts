/**
 * ScheduleStoreJson — JSON 파일.
 *
 * 파일 구조: {dataDir}/schedules/{namespace}.json
 * 참고: dynamic-job-store.ts
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ScheduleStore, ScheduledJob, StoreBackendInfo, DescribableStore } from '@nexora/contracts';

export class ScheduleStoreJson implements ScheduleStore, DescribableStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'schedules');
  }

  describeBackend(): StoreBackendInfo {
    return { name: 'json-file', type: 'dev', durable: true, multiProcess: false };
  }

  private filePath(namespace: string): string {
    return path.join(this.dir, `${namespace}.json`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private readAll(namespace: string): ScheduledJob[] {
    const file = this.filePath(namespace);
    if (!fs.existsSync(file)) return [];
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as ScheduledJob[];
    } catch {
      return [];
    }
  }

  private writeAll(namespace: string, jobs: ScheduledJob[]): void {
    this.ensureDir();
    fs.writeFileSync(this.filePath(namespace), JSON.stringify(jobs, null, 2), 'utf-8');
  }

  async save(namespace: string, job: ScheduledJob): Promise<void> {
    const jobs = this.readAll(namespace).filter(j => j.jobId !== job.jobId);
    jobs.push(job);
    this.writeAll(namespace, jobs);
  }

  async remove(namespace: string, jobId: string): Promise<void> {
    const jobs = this.readAll(namespace).filter(j => j.jobId !== jobId);
    this.writeAll(namespace, jobs);
  }

  async loadAll(namespace: string): Promise<ScheduledJob[]> {
    return this.readAll(namespace);
  }
}
