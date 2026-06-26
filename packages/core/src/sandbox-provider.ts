/**
 * createSandboxProvider — 소비 프로젝트(ixpert·in7) 공용 도입 팩토리.
 *
 * 레이어① OS 격리 정책(개방-but-비밀안전: 읽기는 넓게, 비밀 경로만 차단, 네트워크
 * 기본 차단) + 레이어② 대화-단위 고정-root(perRun:false, cleanup:'keep')를 묶어
 * AsrtSandboxClient를 구성한다. 정책 정본을 한 곳에 둬 소비자 간 drift를 막는다.
 *
 * 상위 설계: docs/superpowers/specs/2026-06-24-runtime-isolation-adoption-design.md §3-④, §4.3
 */

import os from 'node:os';
import path from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SnapshotBackend } from '@dongkseo/contracts';
import { AsrtSandboxClient } from './asrt-sandbox-client.js';

/**
 * OS 격리(seatbelt/bubblewrap)가 이 호스트에서 지원되는지. 미지원 호스트(예: bwrap/ripgrep
 * 없는 Linux, WSL1)에서는 sandbox provider 의 acquire 가 매 턴 throw 한다 — 소비자는 부트 시
 * 이걸로 확인해 격리 없이 조용히 도는 대신 명확히 실패(또는 명시적 비활성)하게 한다.
 */
export function isSandboxSupported(): boolean {
  return SandboxManager.isSupportedPlatform();
}

/**
 * 항상 읽기 차단되는 비밀 경로(홈 기준 절대경로). 소비자 denyRead는 여기에 병합되며
 * 이 목록을 무력화할 수 없다. "개방" 철학상 그 외 읽기는 넓게 허용한다.
 */
export const SANDBOX_SECRET_DENYLIST: readonly string[] = [
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.aws'),
  path.join(os.homedir(), '.config', 'gcloud'),
  path.join(os.homedir(), '.config', 'gh'),
  path.join(os.homedir(), '.gnupg'),
  path.join(os.homedir(), '.kube'),
  path.join(os.homedir(), '.docker', 'config.json'),
  path.join(os.homedir(), '.netrc'),
  path.join(os.homedir(), '.npmrc'),
  path.join(os.homedir(), 'Library', 'Keychains'),
];

export interface SandboxProviderOptions {
  /** 에이전트가 접근 가능한 네트워크 도메인. 기본 [] → 전면 차단. */
  allowedDomains?: string[];
  /** 추가 읽기-차단 경로. 비밀 denylist에 병합되며 비밀 차단을 무력화할 수 없다. */
  denyRead?: string[];
  /** 워크스페이스 root 외에 읽기 허용할 경로. */
  allowRead?: string[];
  /** 매 run마다 새 tmp root(true) vs 대화 root 재사용(false). 기본 false. */
  perRun?: boolean;
  /** perRun:true일 때 tmp root들이 생기는 베이스 디렉토리. */
  baseDir?: string;
  /** 고정 root 오버라이드(대화별 baseWorkdir보다 우선). */
  root?: string;
  /** 정리 모드. 기본 'keep'(대화 영속). */
  cleanup?: 'keep' | 'delete';
  /** 영속 스냅샷 백엔드. 기본 inline-root(NoopSnapshotBackend). */
  snapshotBackend?: SnapshotBackend;
}

/** 개방-but-비밀안전 정책 + 대화-단위 영속으로 구성한 WorkspaceProvider. */
export function createSandboxProvider(options: SandboxProviderOptions = {}): AsrtSandboxClient {
  return new AsrtSandboxClient({
    mode: 'workspace-write',
    perRun: options.perRun ?? false,
    cleanup: options.cleanup ?? 'keep',
    baseDir: options.baseDir,
    root: options.root,
    allowedDomains: options.allowedDomains ?? [],
    denyRead: [...SANDBOX_SECRET_DENYLIST, ...(options.denyRead ?? [])],
    allowRead: options.allowRead ?? [],
    snapshotBackend: options.snapshotBackend,
  });
}
