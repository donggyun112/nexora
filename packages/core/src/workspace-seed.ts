/**
 * materializeSeedDirs — 워크스페이스 root가 정해진 직후, WorkspaceAcquireOptions.seedDirs로
 * 선언된 디렉토리들을 root 안으로 복사한다. 소스가 없거나 읽기 실패해도 조용히 skip한다
 * (best-effort — 지원 파일이 없어도 에이전트는 정상 동작해야 한다). 심볼릭 링크는 절대
 * 따라가지 않는다(워크스페이스 밖을 가리키는 링크가 root-jail을 무력화하지 않도록).
 *
 * 매 acquire()/resume() 마다 다시 호출돼 최신 소스로 덮어쓴다 — "최초 1회만 seed"는 소스가
 * 대화 중간에 갱신될 때 stale 콘텐츠를 남긴다.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolvePathAgainstRoot } from '@dongkseo/contracts';

export interface WorkspaceSeedEntry {
  /** 복사할 소스 디렉토리(절대/상대 모두 허용, 내부적으로 resolve). */
  readonly source: string;
  /** 워크스페이스 root 기준 목적지 상대경로. */
  readonly destSubpath: string;
}

export async function materializeSeedDirs(
  root: string,
  seedDirs?: ReadonlyArray<WorkspaceSeedEntry>,
): Promise<void> {
  if (!seedDirs || seedDirs.length === 0) return;
  for (const entry of seedDirs) {
    await materializeSeedDir(root, entry);
  }
}

async function materializeSeedDir(root: string, entry: WorkspaceSeedEntry): Promise<void> {
  const source = path.resolve(entry.source);
  if (!(await isDirectory(source))) return;

  // The destination must stay inside the workspace root: a `destSubpath` such as
  // `../escape` would otherwise seed files outside the jail. Validate before any
  // write, and skip (best-effort) rather than throwing on an out-of-root target.
  let dest: string;
  try {
    ({ finalPath: dest } = await resolvePathAgainstRoot(entry.destSubpath, root));
  } catch {
    return;
  }
  if (dest === root) return; // never overwrite the workspace root itself

  try {
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.cp(source, dest, {
      recursive: true,
      force: true,
      filter: async (src: string) => {
        try {
          return !(await fsp.lstat(src)).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });
  } catch {
    // Silently swallow copy errors (best-effort guarantee).
    // Any fs error during rm/mkdir/cp is non-fatal — the workspace should still function.
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}
