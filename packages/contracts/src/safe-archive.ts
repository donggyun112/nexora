/**
 * Safe archive boundary — dependency-free tar writer + hardened extractor.
 *
 * This is the filesystem trust boundary for workspace snapshots and remote
 * hydrate. A snapshot archive is "saved workspace bytes" that may be restored
 * into a fresh root on a later turn or host; if those bytes are ever tampered
 * with (shared backend, remote transfer, poisoned upload), naive extraction can
 * write outside the destination root. This module rejects traversal, unsafe
 * symlinks, hardlinks, unsupported member types, and archive resource bombs, and
 * extracts members itself with `O_NOFOLLOW` (creating symlinks last) so a
 * malicious archive cannot pivot through a symlink it just created.
 *
 * One rule is opt-out for self-produced archives: `ExtractOptions.allowAbsoluteSymlinks`
 * permits *creating* absolute symlink targets (an overlay upper dir cannot round-trip
 * otherwise). It does not relax writing *through* symlinks — that stays blocked by the
 * symlinks-last ordering, `O_NOFOLLOW`, and the parent-chain re-check.
 *
 * Faithful port of the reference SDK's `util/tar_utils.py` +
 * `session/archive_extraction.py` (see
 * `.agents/references/sandbox-runtime-boundary.md` — "Filesystem Trust Boundary").
 *
 * The writer emits USTAR with PAX (`x`) extended headers for long paths, long
 * link targets, and large sizes. The reader additionally understands GNU
 * longname/longlink (`L`/`K`) records so archives produced by the system `tar`
 * also extract safely.
 */

import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const BLOCK = 512;

/** Raised when a tar member would escape the root or violate extraction rules. */
export class UnsafeArchiveMemberError extends Error {
  constructor(
    public readonly member: string,
    public readonly reason: string,
  ) {
    super(`unsafe archive member ${JSON.stringify(member)}: ${reason}`);
    this.name = 'UnsafeArchiveMemberError';
  }
}

/** Raised when an archive exceeds a configured extraction resource limit. */
export class ArchiveLimitError extends Error {
  constructor(
    public readonly reason: string,
    public readonly limit: number,
    public readonly actual: number,
    public readonly member?: string,
  ) {
    super(`${reason} (limit ${limit}, actual ${actual})`);
    this.name = 'ArchiveLimitError';
  }
}

/** Bounds enforced during extraction to defend against archive bombs. */
export interface ArchiveLimits {
  /** Maximum number of members. */
  maxMembers?: number;
  /** Maximum total bytes across all regular files. */
  maxExtractedBytes?: number;
}

/**
 * Options accepted by {@link safeExtractTar}. Extends {@link ArchiveLimits} so every existing
 * caller keeps compiling, while permission flags stay out of `ArchiveLimits` itself: that type is
 * embedded in operator-facing option bags that reach wire-facing hydrate endpoints, and a
 * permission is not a bound.
 */
export interface ExtractOptions extends ArchiveLimits {
  /**
   * Permit members whose symlink target is absolute (`/opt/x`). Off by default.
   *
   * **Only enable for archives you produced yourself.** It exists because an overlay upper dir
   * cannot round-trip without it: a package manager inevitably writes absolute links such as
   * `/etc/alternatives/editor`, and a single one would otherwise fail the whole extraction.
   *
   * What this does NOT relax: extraction still refuses to *write through* any symlink. Links are
   * created last, after every file and directory; each write opens with `O_NOFOLLOW`, and
   * `ensureNoSymlinkParents` re-checks the parent chain. So an absolute link can be created but
   * never used as a pivot by its own archive. Relative targets escaping the root stay rejected.
   */
  allowAbsoluteSymlinks?: boolean;
}

type MemberType = 'file' | 'directory' | 'symlink';

interface ParsedMember {
  name: string;
  type: MemberType;
  size: number;
  linkname: string;
  /** Permission bits from the header, already masked to `0o777`. */
  mode: number;
  /** Offset of the member's file data within the archive buffer. */
  dataOffset: number;
}

// ── Reading ────────────────────────────────────────────────────────────────

function readCString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('latin1');
}

/**
 * Read a tar numeric field. Handles octal (space/NUL padded) and GNU base-256
 * binary encoding (used for sizes that do not fit in the octal field).
 */
function readNumeric(buf: Buffer, offset: number, length: number): number {
  const first = buf[offset];
  if (first & 0x80) {
    // GNU base-256: high bit set marks a big-endian binary integer.
    let value = first & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + buf[offset + i];
    return value;
  }
  const text = readCString(buf, offset, length).trim();
  if (text === '') return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isZeroBlock(buf: Buffer, offset: number): boolean {
  for (let i = 0; i < BLOCK; i++) {
    if (buf[offset + i] !== 0) return false;
  }
  return true;
}

function verifyChecksum(buf: Buffer, offset: number): boolean {
  const stored = readNumeric(buf, offset + 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    // The checksum field itself is treated as ASCII spaces during the sum.
    const byte = i >= 148 && i < 156 ? 0x20 : buf[offset + i];
    unsigned += byte;
    signed += byte < 128 ? byte : byte - 256;
  }
  return stored === unsigned || stored === signed;
}

function parsePaxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let pos = 0;
  // Records are "<len> <key>=<value>\n" where <len> is the byte length of the
  // whole record. Parse over bytes (not the decoded string) so multi-byte UTF-8
  // keys/values do not desynchronize the length arithmetic.
  while (pos < data.length) {
    let space = pos;
    while (space < data.length && data[space] !== 0x20) space++;
    if (space >= data.length) break;
    const len = Number.parseInt(data.subarray(pos, space).toString('latin1'), 10);
    if (!Number.isFinite(len) || len <= 0 || pos + len > data.length + 0) break;
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8'); // drop trailing '\n'
    const eq = record.indexOf('=');
    if (eq !== -1) out.set(record.slice(0, eq), record.slice(eq + 1));
    pos += len;
  }
  return out;
}

/**
 * Parse a tar archive buffer into a flat member list. Resolves PAX (`x`) and GNU
 * (`L`/`K`) name/link/size overrides. Does not read file data (callers use
 * `dataOffset` + `size`).
 */
function parseMembers(buf: Buffer): ParsedMember[] {
  const members: ParsedMember[] = [];
  let offset = 0;
  let paxPath: string | undefined;
  let paxLink: string | undefined;
  let paxSize: number | undefined;
  let gnuName: string | undefined;
  let gnuLink: string | undefined;

  while (offset + BLOCK <= buf.length) {
    if (isZeroBlock(buf, offset)) break; // end-of-archive marker
    if (!verifyChecksum(buf, offset)) {
      throw new UnsafeArchiveMemberError('<header>', 'invalid tar header checksum');
    }

    const rawName = readCString(buf, offset, 100);
    const size = readNumeric(buf, offset + 124, 12);
    const typeByte = buf[offset + 156];
    const typeflag = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    const linkname = readCString(buf, offset + 157, 100);
    const prefix = readCString(buf, offset + 345, 155);
    const dataOffset = offset + BLOCK;
    const paddedData = Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'x') {
      const records = parsePaxRecords(buf.subarray(dataOffset, dataOffset + size));
      paxPath = records.get('path') ?? paxPath;
      paxLink = records.get('linkpath') ?? paxLink;
      const s = records.get('size');
      if (s !== undefined) paxSize = Number.parseInt(s, 10);
      offset = dataOffset + paddedData;
      continue;
    }
    if (typeflag === 'g') {
      offset = dataOffset + paddedData; // global PAX header: ignored
      continue;
    }
    if (typeflag === 'L') {
      gnuName = readCString(buf, dataOffset, size).replace(/\0+$/, '');
      offset = dataOffset + paddedData;
      continue;
    }
    if (typeflag === 'K') {
      gnuLink = readCString(buf, dataOffset, size).replace(/\0+$/, '');
      offset = dataOffset + paddedData;
      continue;
    }

    const ustarName = prefix ? `${prefix}/${rawName}` : rawName;
    const name = paxPath ?? gnuName ?? ustarName;
    const effLink = paxLink ?? gnuLink ?? linkname;
    const effSize = paxSize ?? size;

    let type: MemberType | null;
    if (typeflag === '5') type = 'directory';
    else if (typeflag === '2') type = 'symlink';
    else if (typeflag === '0') type = 'file';
    else type = null; // '1' hardlink, '3'/'4' device, '6' fifo, etc.

    if (type === null) {
      const reason =
        typeflag === '1' ? 'hardlink member not allowed' : `unsupported member type ${typeflag}`;
      throw new UnsafeArchiveMemberError(name, reason);
    }

    // Mask to 0o777: setuid/setgid/sticky are never honoured from an archive, so a crafted
    // member cannot plant a privilege-escalating binary in the destination root.
    const mode = readNumeric(buf, offset + 100, 8) & 0o777;
    members.push({ name, type, size: effSize, linkname: effLink, dataOffset, mode });
    // Advance past the file DATA using the effective size: a PAX `size` record
    // overrides a zeroed header size field, so trusting the header size here
    // would land the next header read inside the file body.
    offset = dataOffset + Math.ceil(effSize / BLOCK) * BLOCK;

    paxPath = paxLink = gnuName = gnuLink = undefined;
    paxSize = undefined;
  }

  return members;
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Split a member path into safe components or reject it. */
function safeRelParts(name: string): string[] {
  const trimmed = name.replace(/\/+$/, ''); // tar dirs often end with '/'
  if (trimmed === '' || trimmed === '.' ) {
    return [];
  }
  if (/^[A-Za-z]:/.test(trimmed)) {
    throw new UnsafeArchiveMemberError(name, 'windows drive path');
  }
  if (trimmed.includes('\\')) {
    throw new UnsafeArchiveMemberError(name, 'windows path separator');
  }
  if (trimmed.startsWith('/')) {
    throw new UnsafeArchiveMemberError(name, 'absolute path');
  }
  const parts = trimmed.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) {
    throw new UnsafeArchiveMemberError(name, 'parent traversal');
  }
  return parts;
}

/** Reject a symlink whose target would resolve outside the archive root. */
function validateSymlinkTarget(
  name: string,
  relParts: string[],
  target: string,
  allowAbsolute = false,
): void {
  if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) {
    if (!allowAbsolute) {
      throw new UnsafeArchiveMemberError(name, `absolute symlink target not allowed: ${target}`);
    }
    // Return rather than fall through: the containment arithmetic below resolves the target
    // against the member's parent, which is meaningless for an absolute path. Skipping only the
    // throw would let `/etc/passwd` reduce to the stack ['etc','passwd'] and silently "pass",
    // implying a containment check that never happened.
    return;
  }
  // Resolve the target relative to the symlink's parent directory and ensure it
  // does not climb above the root.
  const parent = relParts.slice(0, -1);
  const combined = [...parent, ...target.split('/')];
  const stack: string[] = [];
  for (const seg of combined) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) {
        throw new UnsafeArchiveMemberError(name, `symlink target escapes root: ${target}`);
      }
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
}

interface PlannedMember extends ParsedMember {
  relParts: string[];
}

/** Validate every member and enforce resource limits (single pass, no bombs). */
function planExtraction(members: ParsedMember[], options: ExtractOptions | undefined): PlannedMember[] {
  const maxMembers = options?.maxMembers;
  const maxBytes = options?.maxExtractedBytes;

  const planned: PlannedMember[] = [];
  const byPath = new Map<string, PlannedMember>();
  const symlinkPaths = new Set<string>();
  let count = 0;
  let bytes = 0;

  for (const member of members) {
    const relParts = safeRelParts(member.name);
    if (relParts.length === 0) continue; // root entry ('.' / '')

    count += 1;
    if (maxMembers !== undefined && count > maxMembers) {
      throw new ArchiveLimitError('archive member count exceeds limit', maxMembers, count, member.name);
    }
    if (member.type === 'file') {
      bytes += Math.max(member.size, 0);
      if (maxBytes !== undefined && bytes > maxBytes) {
        throw new ArchiveLimitError('archive extracted size exceeds limit', maxBytes, bytes, member.name);
      }
    }
    if (member.type === 'symlink') {
      validateSymlinkTarget(member.name, relParts, member.linkname, options?.allowAbsoluteSymlinks);
    }

    const key = relParts.join('/');
    const previous = byPath.get(key);
    if (previous && !(previous.type === 'directory' && member.type === 'directory')) {
      throw new UnsafeArchiveMemberError(member.name, `duplicate archive path: ${key}`);
    }

    const entry: PlannedMember = { ...member, relParts };
    byPath.set(key, entry);
    if (member.type === 'symlink') symlinkPaths.add(key);
    planned.push(entry);
  }

  // No member may descend through a symlink or a non-directory member declared
  // earlier in the archive.
  for (const member of planned) {
    for (let i = 1; i < member.relParts.length; i++) {
      const parentKey = member.relParts.slice(0, i).join('/');
      if (symlinkPaths.has(parentKey)) {
        throw new UnsafeArchiveMemberError(member.name, `archive path descends through symlink: ${parentKey}`);
      }
      const parent = byPath.get(parentKey);
      if (parent && parent.type !== 'directory') {
        throw new UnsafeArchiveMemberError(member.name, `archive path descends through non-directory: ${parentKey}`);
      }
    }
  }

  return planned;
}

// ── Extraction ───────────────────────────────────────────────────────────────

/** Ensure no existing on-disk parent component of `relParts` is a symlink. */
async function ensureNoSymlinkParents(root: string, relParts: string[]): Promise<void> {
  let current = root;
  for (let i = 0; i < relParts.length - 1; i++) {
    current = path.join(current, relParts[i]);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch {
      return; // does not exist yet — nothing to pivot through
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafeArchiveMemberError(relParts.join('/'), `symlink in parent path: ${relParts.slice(0, i + 1).join('/')}`);
    }
  }
}

/**
 * Safely extract a tar archive (buffer) into `destRoot`.
 *
 * Directories and regular files are created first; symlinks are created last so
 * a member cannot be extracted through a symlink the same archive introduces.
 * Regular files are opened with `O_CREAT | O_EXCL | O_NOFOLLOW` so a pre-existing
 * symlink at the destination path cannot redirect the write.
 */
export async function safeExtractTar(
  archive: Buffer,
  destRoot: string,
  options?: ExtractOptions,
): Promise<void> {
  const members = planExtraction(parseMembers(archive), options);
  await fsp.mkdir(destRoot, { recursive: true, mode: 0o700 });
  const root = await fsp.realpath(destRoot);

  // Pass 1: directories and files.
  for (const member of members) {
    const dest = path.join(root, ...member.relParts);
    if (member.type === 'directory') {
      await ensureNoSymlinkParents(root, member.relParts);
      await fsp.mkdir(dest, { recursive: true });
      continue;
    }
    if (member.type === 'file') {
      await ensureNoSymlinkParents(root, member.relParts);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await writeFileNoFollow(
        dest,
        archive.subarray(member.dataOffset, member.dataOffset + member.size),
        member.mode,
      );
    }
  }

  // Pass 2: symlinks, after all real files exist.
  for (const member of members) {
    if (member.type !== 'symlink') continue;
    const dest = path.join(root, ...member.relParts);
    await ensureNoSymlinkParents(root, member.relParts);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rm(dest, { force: true });
    await fsp.symlink(member.linkname, dest);
  }
}

async function writeFileNoFollow(dest: string, data: Buffer, mode: number): Promise<void> {
  await fsp.rm(dest, { force: true }); // replace any existing regular file
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  // Create restrictively, then widen via the open handle. `open`'s mode argument is filtered by
  // the process umask, so it cannot reproduce the recorded permissions exactly; `fchmod` on the
  // handle can — and operating on the fd rather than the path leaves no window for a swap.
  const handle = await fsp.open(dest, flags, 0o600);
  try {
    await handle.writeFile(data);
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

// ── Writing ────────────────────────────────────────────────────────────────

interface TarEntry {
  relParts: string[];
  type: MemberType;
  data?: Buffer;
  linkname?: string;
  mode?: number;
}

/** Archive a directory tree into a tar buffer (USTAR + PAX for long fields). */
export async function writeTar(rootDir: string): Promise<Buffer> {
  const root = await fsp.realpath(rootDir);
  const entries: TarEntry[] = [];
  await collectEntries(root, [], entries);
  entries.sort((a, b) => a.relParts.join('/').localeCompare(b.relParts.join('/')));

  const chunks: Buffer[] = [];
  for (const entry of entries) chunks.push(...encodeEntry(entry));
  chunks.push(Buffer.alloc(BLOCK * 2)); // two zero blocks terminate the archive
  return Buffer.concat(chunks);
}

async function collectEntries(root: string, rel: string[], out: TarEntry[]): Promise<void> {
  const dir = rel.length === 0 ? root : path.join(root, ...rel);
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));
  for (const dirent of dirents) {
    const childRel = [...rel, dirent.name];
    if (dirent.isSymbolicLink()) {
      const linkname = await fsp.readlink(path.join(root, ...childRel));
      out.push({ relParts: childRel, type: 'symlink', linkname });
    } else if (dirent.isDirectory()) {
      out.push({ relParts: childRel, type: 'directory' });
      await collectEntries(root, childRel, out);
    } else if (dirent.isFile()) {
      const full = path.join(root, ...childRel);
      const data = await fsp.readFile(full);
      out.push({ relParts: childRel, type: 'file', data, mode: (await fsp.stat(full)).mode & 0o777 });
    }
    // Sockets, fifos, and devices are intentionally skipped.
  }
}

function encodeEntry(entry: TarEntry): Buffer[] {
  const name = entry.relParts.join('/') + (entry.type === 'directory' ? '/' : '');
  const size = entry.type === 'file' ? (entry.data?.length ?? 0) : 0;
  const linkname = entry.linkname ?? '';

  // Decide whether the plain USTAR fields can hold the path/link/size; otherwise
  // emit a PAX extended header carrying the oversized fields verbatim.
  const pax = new Map<string, string>();
  if (Buffer.byteLength(name) > 100) pax.set('path', entry.relParts.join('/'));
  if (Buffer.byteLength(linkname) > 100) pax.set('linkpath', linkname);
  if (size > 0o77777777777) pax.set('size', String(size));

  const blocks: Buffer[] = [];
  if (pax.size > 0) {
    const paxData = encodePaxRecords(pax);
    blocks.push(buildHeader({ name: `PaxHeader/${entry.relParts.join('/')}`.slice(0, 100), size: paxData.length, typeflag: 'x', mode: 0o644 }));
    blocks.push(padTo512(paxData));
  }

  const typeflag = entry.type === 'directory' ? '5' : entry.type === 'symlink' ? '2' : '0';
  blocks.push(
    buildHeader({
      name: pax.has('path') ? truncateForHeader(name) : name,
      size: pax.has('size') ? 0 : size,
      typeflag,
      linkname: pax.has('linkpath') ? '' : linkname,
      // Directories and symlinks keep conventional modes; only regular files carry the
      // recorded one (a symlink's own mode is not meaningful on Linux).
      mode: entry.type === 'file' ? (entry.mode ?? 0o644) : entry.type === 'directory' ? 0o755 : 0o777,
    }),
  );
  if (entry.type === 'file' && entry.data && entry.data.length > 0) {
    blocks.push(padTo512(entry.data));
  }
  return blocks;
}

function truncateForHeader(name: string): string {
  // A PAX `path` record is authoritative; the ustar name is only a fallback for
  // readers that ignore PAX, so a truncated basename is acceptable here.
  const buf = Buffer.from(name, 'utf8').subarray(0, 100);
  return buf.toString('latin1');
}

function encodePaxRecords(records: Map<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of records) {
    const body = `${key}=${value}\n`;
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    // The length prefix counts its own digits, so solve for the total byte length.
    let len = bodyBytes + 2;
    while (String(len).length + 1 + bodyBytes !== len) len = String(len).length + 1 + bodyBytes;
    parts.push(Buffer.from(`${len} ${body}`, 'utf8'));
  }
  return Buffer.concat(parts);
}

interface HeaderFields {
  name: string;
  size: number;
  typeflag: string;
  linkname?: string;
  mode: number;
}

function buildHeader(fields: HeaderFields): Buffer {
  const header = Buffer.alloc(BLOCK);
  writeString(header, fields.name, 0, 100);
  writeOctal(header, fields.mode & 0o777, 100, 8); // mode
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, fields.size, 124, 12);
  writeOctal(header, 0, 136, 12); // mtime (deterministic)
  header.write(fields.typeflag, 156, 1, 'latin1');
  if (fields.linkname) writeString(header, fields.linkname, 157, 100);
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');

  // Checksum: sum of all bytes with the checksum field as spaces.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i];
  writeOctal(header, sum, 148, 7); // 6 octal digits + trailing NUL
  header[155] = 0x20; // trailing space after checksum
  return header;
}

function writeString(buf: Buffer, value: string, offset: number, length: number): void {
  const encoded = Buffer.from(value, 'utf8').subarray(0, length - 1);
  encoded.copy(buf, offset);
}

function writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, '0').slice(-(length - 1));
  buf.write(text, offset, length - 1, 'latin1');
  buf[offset + length - 1] = 0; // NUL terminator
}

function padTo512(data: Buffer): Buffer {
  const remainder = data.length % BLOCK;
  if (remainder === 0) return data;
  return Buffer.concat([data, Buffer.alloc(BLOCK - remainder)]);
}
