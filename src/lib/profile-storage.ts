// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function lstatIfExists(candidate: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(candidate);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function nearestExistingDirectory(candidate: string): string {
  let cursor = path.resolve(candidate);
  while (!lstatIfExists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const stat = fs.lstatSync(cursor);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`nearest private storage ancestor is unsafe: ${cursor}`);
  }
  return cursor;
}

/**
 * Stable, collision-resistant owner key. Display names are only a standalone
 * fallback; managed workers must provide their immutable database agent id.
 */
export function stableProfileOwnerKey(
  stableId: string | undefined,
  displayFallback: string,
  managed: boolean,
): string {
  const normalizedId = stableId?.trim();
  if (managed && !normalizedId) {
    throw new Error('ID_AGENT_ID is required for profile-owned agent storage');
  }
  const identity = normalizedId || displayFallback.trim() || 'agent';
  const slug = identity
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[_\-.]+|[_\-.]+$/g, '')
    .slice(0, 48) || 'agent';
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 24);
  return `${slug}-${digest}`;
}

function requireSecureRoot(root: string): string {
  const absolute = path.resolve(root);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`private storage root is not a real directory: ${absolute}`);
  }
  return fs.realpathSync(absolute);
}

/**
 * Reject symlinks/junctions in every existing component below a trusted root
 * and return an absolute path within the root.
 */
export function assertNoLinkEscape(root: string, candidate: string): string {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  if (!pathIsWithin(absoluteRoot, absoluteCandidate)) {
    throw new Error(`private storage path escapes its root: ${absoluteCandidate}`);
  }

  const canonicalRoot = requireSecureRoot(absoluteRoot);
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  let cursor = absoluteRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = lstatIfExists(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`private storage path contains a symlink or junction: ${cursor}`);
    }
    const canonical = fs.realpathSync(cursor);
    if (!pathIsWithin(canonicalRoot, canonical)) {
      throw new Error(`private storage path resolves outside its root: ${cursor}`);
    }
  }
  return absoluteCandidate;
}

/** Create a directory one component at a time without following planted links. */
export function ensurePrivateDirectory(root: string, directory: string): string {
  const absoluteRoot = path.resolve(root);
  const absoluteDirectory = assertNoLinkEscape(absoluteRoot, directory);
  const relative = path.relative(absoluteRoot, absoluteDirectory);
  let cursor = absoluteRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!lstatIfExists(cursor)) {
      fs.mkdirSync(cursor, { mode: 0o700 });
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`private storage directory is unsafe: ${cursor}`);
    }
    const canonicalRoot = fs.realpathSync(absoluteRoot);
    if (!pathIsWithin(canonicalRoot, fs.realpathSync(cursor))) {
      throw new Error(`private storage directory resolves outside its root: ${cursor}`);
    }
    try { fs.chmodSync(cursor, 0o700); } catch { /* best effort outside POSIX */ }
  }
  return absoluteDirectory;
}

function assertRegularFileNoFollow(root: string, filePath: string): string {
  const absolute = assertNoLinkEscape(root, filePath);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`private storage file is not a regular no-follow file: ${absolute}`);
  }
  return absolute;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino;
}

/**
 * O_NOFOLLOW is unavailable on Windows. Identity snapshots around open also
 * close the lstat/open reparse-point race there (and provide defense in depth
 * on POSIX).
 */
function assertOpenedFileIdentity(
  root: string,
  filePath: string,
  beforeOpen: fs.Stats,
  fd: number,
): void {
  const opened = fs.fstatSync(fd);
  assertNoLinkEscape(root, filePath);
  const afterOpen = fs.lstatSync(filePath);
  if (
    afterOpen.isSymbolicLink()
    || !sameFileIdentity(beforeOpen, opened)
    || !sameFileIdentity(opened, afterOpen)
  ) {
    throw new Error(`private storage file changed during no-follow open: ${filePath}`);
  }
}

/** Read a retained private file without following a final symlink. */
export function readPrivateFileNoFollow(
  root: string,
  filePath: string,
  options: { harden?: boolean; maxBytes?: number } = {},
): Buffer {
  const absolute = assertRegularFileNoFollow(root, filePath);
  const beforeOpen = fs.lstatSync(absolute);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(absolute, flags);
  try {
    assertOpenedFileIdentity(root, absolute, beforeOpen, fd);
    const maxBytes = options.maxBytes;
    if (
      maxBytes !== undefined
      && (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || fs.fstatSync(fd).size > maxBytes)
    ) {
      throw new Error(`private storage file exceeds its read limit: ${absolute}`);
    }
    if (options.harden) {
      try { fs.fchmodSync(fd, 0o600); } catch { /* best effort outside POSIX */ }
    }
    let contents: Buffer;
    if (maxBytes === undefined) {
      contents = fs.readFileSync(fd);
    } else {
      const chunks: Buffer[] = [];
      let total = 0;
      const buffer = Buffer.allocUnsafe(Math.min(PRIVATE_COPY_BUFFER_BYTES, maxBytes + 1));
      while (true) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) {
          throw new Error(`private storage file exceeds its read limit: ${absolute}`);
        }
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        if (total === maxBytes) {
          const probe = Buffer.allocUnsafe(1);
          if (fs.readSync(fd, probe, 0, 1, null) > 0) {
            throw new Error(`private storage file exceeds its read limit: ${absolute}`);
          }
          break;
        }
      }
      contents = Buffer.concat(chunks, total);
    }
    assertOpenedFileIdentity(root, absolute, beforeOpen, fd);
    return contents;
  } finally {
    fs.closeSync(fd);
  }
}

export interface AtomicPrivateWriteOptions {
  /** Publish only if destination is absent; returns false when already present. */
  noOverwrite?: boolean;
}

export const PRIVATE_COPY_BUFFER_BYTES = 64 * 1024;

export interface PrivateFileCopyOptions {
  /** Test/telemetry seam; production copying always uses the fixed buffer. */
  onChunk?: (chunkBytes: number, bufferCapacity: number) => void;
  /** Atomically replace an existing regular destination after the copy. */
  replaceExisting?: boolean;
}

/**
 * Same-directory temporary write followed by atomic publication. Temporary and
 * retained files are opened with O_NOFOLLOW and forced to owner-only mode.
 */
export function atomicWritePrivateFile(
  root: string,
  filePath: string,
  contents: string | Buffer,
  options: AtomicPrivateWriteOptions = {},
): boolean {
  const absolute = path.resolve(filePath);
  const parent = ensurePrivateDirectory(root, path.dirname(absolute));
  assertNoLinkEscape(root, absolute);
  if (lstatIfExists(absolute)) {
    assertRegularFileNoFollow(root, absolute);
    if (options.noOverwrite) return false;
  }

  const temporary = path.join(
    parent,
    `.${path.basename(absolute)}.${process.pid}.${randomBytes(10).toString('hex')}.tmp`,
  );
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, flags, 0o600);
    const temporaryIdentity = fs.lstatSync(temporary);
    assertOpenedFileIdentity(root, temporary, temporaryIdentity, fd);
    fs.writeFileSync(fd, contents);
    try { fs.fchmodSync(fd, 0o600); } catch { /* best effort outside POSIX */ }
    fs.fsyncSync(fd);
    assertOpenedFileIdentity(root, temporary, temporaryIdentity, fd);
    fs.closeSync(fd);
    fd = undefined;

    // Recheck the destination after the temporary write.
    assertNoLinkEscape(root, absolute);
    if (lstatIfExists(absolute)) {
      assertRegularFileNoFollow(root, absolute);
      if (options.noOverwrite) return false;
    }

    if (options.noOverwrite) {
      try {
        fs.linkSync(temporary, absolute);
      } catch (error: any) {
        if (error?.code === 'EEXIST') return false;
        throw error;
      }
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, absolute);
    }
    try { fs.chmodSync(absolute, 0o600); } catch { /* best effort outside POSIX */ }
    return true;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* already published/absent */ }
  }
}

/** Copy one exact regular file without following source or destination links. */
export function copyPrivateFileNoFollow(
  sourceRoot: string,
  sourcePath: string,
  destinationRoot: string,
  destinationPath: string,
  options: PrivateFileCopyOptions = {},
): boolean {
  const source = assertRegularFileNoFollow(sourceRoot, sourcePath);
  const destination = path.resolve(destinationPath);
  const destinationParent = ensurePrivateDirectory(
    destinationRoot,
    path.dirname(destination),
  );
  assertNoLinkEscape(destinationRoot, destination);
  if (lstatIfExists(destination)) {
    assertRegularFileNoFollow(destinationRoot, destination);
    if (!options.replaceExisting) return false;
  }

  const temporary = path.join(
    destinationParent,
    `.${path.basename(destination)}.${process.pid}.${randomBytes(10).toString('hex')}.copy`,
  );
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let sourceFd: number | undefined;
  let destinationFd: number | undefined;
  try {
    const sourceBeforeOpen = fs.lstatSync(source);
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    assertOpenedFileIdentity(sourceRoot, source, sourceBeforeOpen, sourceFd);
    destinationFd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | noFollow,
      0o600,
    );
    const destinationBeforeOpen = fs.lstatSync(temporary);
    assertOpenedFileIdentity(
      destinationRoot,
      temporary,
      destinationBeforeOpen,
      destinationFd,
    );

    const buffer = Buffer.allocUnsafe(PRIVATE_COPY_BUFFER_BYTES);
    while (true) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      options.onChunk?.(bytesRead, buffer.length);
      let written = 0;
      while (written < bytesRead) {
        const bytesWritten = fs.writeSync(
          destinationFd,
          buffer,
          written,
          bytesRead - written,
          null,
        );
        if (bytesWritten <= 0) {
          throw new Error(`bounded private copy made no write progress: ${destination}`);
        }
        written += bytesWritten;
      }
    }
    try { fs.fchmodSync(destinationFd, 0o600); } catch { /* best effort outside POSIX */ }
    fs.fsyncSync(destinationFd);
    // Reject source/destination parent-chain replacements that happened while
    // the bounded copy was in progress; the temp file is not yet published.
    assertOpenedFileIdentity(sourceRoot, source, sourceBeforeOpen, sourceFd);
    assertOpenedFileIdentity(
      destinationRoot,
      temporary,
      destinationBeforeOpen,
      destinationFd,
    );
    fs.closeSync(sourceFd);
    sourceFd = undefined;
    fs.closeSync(destinationFd);
    destinationFd = undefined;

    // Publish without overwriting retained profile state, including a file
    // created concurrently after the initial destination check.
    assertNoLinkEscape(destinationRoot, destination);
    if (lstatIfExists(destination)) {
      assertRegularFileNoFollow(destinationRoot, destination);
      if (!options.replaceExisting) return false;
    }
    if (options.replaceExisting) {
      fs.renameSync(temporary, destination);
    } else {
      try {
        fs.linkSync(temporary, destination);
      } catch (error: any) {
        if (error?.code === 'EEXIST') return false;
        throw error;
      }
      fs.unlinkSync(temporary);
    }
    try { fs.chmodSync(destination, 0o600); } catch { /* best effort outside POSIX */ }
    return true;
  } finally {
    if (sourceFd !== undefined) {
      try { fs.closeSync(sourceFd); } catch { /* ignore */ }
    }
    if (destinationFd !== undefined) {
      try { fs.closeSync(destinationFd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* already published/absent */ }
  }
}
