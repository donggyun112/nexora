// @ts-nocheck — uses dynamic fs operations on user-provided paths
/**
 * nexora export / nexora import — portable agent packages.
 *
 * Import now validates every tar member path against targetDir
 * before extraction. Rejects absolute paths, `..` traversal, and symlinks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExportOptions {
  output?: string;
  include?: string[];
}

export interface ImportOptions {
  input: string;
  targetDir?: string;
  force?: boolean;
}

export async function exportPackage(options: ExportOptions = {}): Promise<string> {
  const include = options.include ?? ['agents', 'context', 'workflows'];
  const existing = include.filter(dir => fs.existsSync(dir));

  if (existing.length === 0) {
    throw new Error(`Nothing to export. None of [${include.join(', ')}] exist.`);
  }

  const output = options.output ?? `nexora-export-${Date.now()}.tar.gz`;
  await execFileAsync('tar', ['-czf', output, ...existing]);

  const stat = fs.statSync(output);
  console.log(`Exported ${existing.join(', ')} → ${output} (${(stat.size / 1024).toFixed(1)} KB)`);
  return output;
}

export async function importPackage(options: ImportOptions): Promise<string[]> {
  if (!fs.existsSync(options.input)) {
    throw new Error(`File not found: ${options.input}`);
  }

  const targetDir = path.resolve(options.targetDir ?? process.cwd());

  // List all members and validate BEFORE extracting.
  const { stdout: listing } = await execFileAsync('tar', ['-tzf', options.input]);
  const files = listing.trim().split('\n').filter(Boolean);

  // Reject dangerous paths: absolute, `..` traversal, symlink-adjacent patterns
  const dangerous = files.filter(f => {
    if (path.isAbsolute(f)) return true;
    if (f.includes('..')) return true;
    const resolved = path.resolve(targetDir, f);
    if (!resolved.startsWith(targetDir + path.sep) && resolved !== targetDir) return true;
    return false;
  });

  if (dangerous.length > 0) {
    throw new Error(
      `Archive contains dangerous paths that would escape targetDir:\n` +
      dangerous.slice(0, 5).map(f => `  ${f}`).join('\n') +
      (dangerous.length > 5 ? `\n  ... and ${dangerous.length - 5} more` : '') +
      `\nRefusing to extract.`,
    );
  }

  if (!options.force) {
    const conflicts = files.filter(f => fs.existsSync(path.join(targetDir, f)));
    if (conflicts.length > 0) {
      throw new Error(
        `Import would overwrite ${conflicts.length} existing file(s):\n` +
        conflicts.slice(0, 5).map(f => `  ${f}`).join('\n') +
        (conflicts.length > 5 ? `\n  ... and ${conflicts.length - 5} more` : '') +
        `\nUse --force to overwrite.`,
      );
    }
  }

  await execFileAsync('tar', ['-xzf', options.input, '-C', targetDir]);

  console.log(`Imported ${files.length} files from ${options.input} into ${targetDir}`);
  return files;
}
