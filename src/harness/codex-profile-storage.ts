// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  assertNoLinkEscape,
  atomicWritePrivateFile,
  copyPrivateFileNoFollow,
  ensurePrivateDirectory,
  lstatIfExists,
  pathIsWithin,
  readPrivateFileNoFollow,
  type PrivateFileCopyOptions,
} from '../lib/profile-storage.js';

export type ProviderSharingMode = 'auto' | 'copy';
export type ProviderEntryMaterialization = 'hardlink' | 'junction' | 'symlink' | 'copy';
export const CODEX_PROVIDER_COPY_MAX_BYTES = 64 * 1024 * 1024;
export const CODEX_PROVIDER_COPY_MAX_FILES = 2_000;
const CODEX_PROVIDER_COPY_FREE_SPACE_RESERVE = 16 * 1024 * 1024;
const CODEX_AUTH_MAX_BYTES = 1024 * 1024;
const CODEX_LEGACY_SESSION_MAX_BYTES = 512 * 1024 * 1024;
const CODEX_LEGACY_SESSION_SCAN_MAX_ENTRIES = 100_000;
const CODEX_SESSION_META_MAX_BYTES = 64 * 1024;
const CODEX_SESSION_CLAIM_MAX_BYTES = 16 * 1024;
const CODEX_LEGACY_SESSION_FREE_SPACE_RESERVE = 16 * 1024 * 1024;

function canonicalProviderRoot(providerHome: string): string {
  const canonical = fs.realpathSync(path.resolve(providerHome));
  const stat = fs.lstatSync(canonical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Codex provider home is not a directory: ${providerHome}`);
  }
  return canonical;
}

function verifiedProviderSource(providerRoot: string, source: string): fs.Stats {
  if (!pathIsWithin(providerRoot, source)) {
    throw new Error(`Codex provider entry escapes provider home: ${source}`);
  }
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`Codex provider entry is not a regular no-follow entry: ${source}`);
  }
  if (!pathIsWithin(providerRoot, fs.realpathSync(source))) {
    throw new Error(`Codex provider entry resolves outside provider home: ${source}`);
  }
  return stat;
}

function verifySharedLink(source: string, destination: string): boolean {
  try {
    return fs.realpathSync(source) === fs.realpathSync(destination);
  } catch {
    return false;
  }
}

/**
 * Bridge one profile-owned session directory into an immutable per-run home.
 * Directory links target only the stable state directory for the same agent;
 * provider/global session trees are never imported.
 */
export function linkCodexProfileSessionDirectory(
  ownerRoot: string,
  stableStateHome: string,
  runHome: string,
  entryName: 'sessions' | 'archived_sessions',
): void {
  const absoluteOwner = path.resolve(ownerRoot);
  const stableDirectory = ensurePrivateDirectory(
    absoluteOwner,
    path.join(stableStateHome, entryName),
  );
  ensurePrivateDirectory(absoluteOwner, runHome);
  const destination = path.join(runHome, entryName);
  assertNoLinkEscape(absoluteOwner, path.dirname(destination));
  if (lstatIfExists(destination)) {
    if (!verifySharedLink(stableDirectory, destination)) {
      throw new Error(`Codex profile session link points to an unexpected target: ${destination}`);
    }
    return;
  }
  fs.symlinkSync(
    stableDirectory,
    destination,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  if (!verifySharedLink(stableDirectory, destination)) {
    try { fs.unlinkSync(destination); } catch { /* absent */ }
    throw new Error(`Codex profile session link could not be verified: ${destination}`);
  }
}

interface ExactSessionFile {
  source: string;
  relative: string;
  area: 'sessions' | 'archived_sessions';
}

interface SessionFileGeneration {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface CodexSessionMetadata {
  id?: unknown;
  cwd?: unknown;
}

interface CodexSessionClaim {
  version: 1;
  sessionId: string;
  ownerKey: string;
  sourceCwd: string;
}

function exactSessionFilenameMatches(filename: string, sessionId: string): boolean {
  return filename === `${sessionId}.jsonl`
    || filename.endsWith(`-${sessionId}.jsonl`);
}

function findExactSessionFileNoFollow(
  root: string,
  sessionId: string,
): ExactSessionFile | undefined {
  const matches: ExactSessionFile[] = [];
  let visited = 0;
  for (const area of ['sessions', 'archived_sessions'] as const) {
    const areaRoot = path.join(root, area);
    const areaStat = lstatIfExists(areaRoot);
    if (!areaStat) continue;
    if (areaStat.isSymbolicLink() || !areaStat.isDirectory()) {
      throw new Error(`Codex legacy session root is unsafe: ${areaRoot}`);
    }
    const stack: Array<{ directory: string; relative: string; depth: number }> = [{
      directory: areaRoot,
      relative: '',
      depth: 0,
    }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.depth > 8) {
        throw new Error('Codex legacy session layout exceeds the safe traversal depth');
      }
      assertNoLinkEscape(root, current.directory);
      const currentStat = fs.lstatSync(current.directory);
      if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
        throw new Error(`Codex legacy session directory is unsafe: ${current.directory}`);
      }
      for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
        visited += 1;
        if (visited > CODEX_LEGACY_SESSION_SCAN_MAX_ENTRIES) {
          throw new Error(
            `Codex exact-session lookup exceeds ${CODEX_LEGACY_SESSION_SCAN_MAX_ENTRIES} entries`,
          );
        }
        const entryPath = path.join(current.directory, entry.name);
        const relative = path.join(current.relative, entry.name);
        assertNoLinkEscape(root, entryPath);
        const stat = fs.lstatSync(entryPath);
        if (stat.isSymbolicLink()) {
          throw new Error(`Codex legacy session tree contains a link: ${entryPath}`);
        }
        if (stat.isDirectory()) {
          stack.push({
            directory: entryPath,
            relative,
            depth: current.depth + 1,
          });
          continue;
        }
        if (!stat.isFile()) {
          throw new Error(`Codex legacy session tree contains an unsupported entry: ${entryPath}`);
        }
        if (exactSessionFilenameMatches(entry.name, sessionId)) {
          matches.push({ source: entryPath, relative, area });
          if (matches.length > 1) {
            throw new Error(`Codex legacy session id is ambiguous: ${sessionId}`);
          }
        }
      }
      assertNoLinkEscape(root, current.directory);
    }
  }
  return matches[0];
}

function sameSessionFile(
  left: Pick<fs.Stats, 'dev' | 'ino'>,
  right: Pick<fs.Stats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSessionGeneration(
  left: Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>,
  right: Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>,
): boolean {
  return sameSessionFile(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readCodexSessionMetadataNoFollow(
  sourceRoot: string,
  source: string,
): { metadata: CodexSessionMetadata; generation: SessionFileGeneration } {
  const absolute = assertNoLinkEscape(sourceRoot, source);
  const beforeOpen = fs.lstatSync(absolute);
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    throw new Error(`Codex legacy session is not a regular no-follow file: ${source}`);
  }
  if (beforeOpen.size > CODEX_LEGACY_SESSION_MAX_BYTES) {
    throw new Error(
      `Codex legacy session exceeds the ${CODEX_LEGACY_SESSION_MAX_BYTES}-byte migration limit`,
    );
  }
  const fd = fs.openSync(
    absolute,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedBeforeRead = fs.fstatSync(fd);
    assertNoLinkEscape(sourceRoot, absolute);
    const pathAfterOpen = fs.lstatSync(absolute);
    if (
      pathAfterOpen.isSymbolicLink()
      || !openedBeforeRead.isFile()
      || !sameSessionGeneration(beforeOpen, openedBeforeRead)
      || !sameSessionGeneration(openedBeforeRead, pathAfterOpen)
    ) {
      throw new Error(`Codex legacy session changed during no-follow open: ${source}`);
    }
    const buffer = Buffer.allocUnsafe(CODEX_SESSION_META_MAX_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLineEnd = buffer.subarray(0, bytes).indexOf(0x0a);
    if (firstLineEnd < 0) {
      throw new Error('Codex legacy session metadata line exceeds the safe limit');
    }
    const first = JSON.parse(buffer.subarray(0, firstLineEnd).toString('utf8'));
    if (
      first?.type !== 'session_meta'
      || !first.payload
      || typeof first.payload !== 'object'
    ) {
      throw new Error('Codex legacy session does not start with session metadata');
    }
    const openedAfterRead = fs.fstatSync(fd);
    assertNoLinkEscape(sourceRoot, absolute);
    const pathAfterRead = fs.lstatSync(absolute);
    if (
      pathAfterRead.isSymbolicLink()
      || !sameSessionGeneration(openedBeforeRead, openedAfterRead)
      || !sameSessionGeneration(openedAfterRead, pathAfterRead)
    ) {
      throw new Error(`Codex legacy session changed during metadata validation: ${source}`);
    }
    return {
      metadata: {
        id: first.payload.id,
        cwd: first.payload.cwd,
      },
      generation: {
        dev: openedAfterRead.dev,
        ino: openedAfterRead.ino,
        size: openedAfterRead.size,
        mtimeMs: openedAfterRead.mtimeMs,
        ctimeMs: openedAfterRead.ctimeMs,
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}

function assertLegacySessionIdentity(
  root: string,
  source: string,
  sessionId: string,
): { generation: SessionFileGeneration; sourceCwd: string } {
  const { metadata, generation } = readCodexSessionMetadataNoFollow(root, source);
  if (
    metadata.id !== sessionId
    || typeof metadata.cwd !== 'string'
    || metadata.cwd.trim().length === 0
  ) {
    throw new Error(
      `Codex legacy session ${sessionId} has invalid or mismatched session metadata`,
    );
  }
  return { generation, sourceCwd: metadata.cwd };
}

function claimExactLegacySession(
  ownerRoot: string,
  sessionId: string,
  sourceCwd: string,
): void {
  const absoluteOwnerRoot = path.resolve(ownerRoot);
  const overlayRoot = path.dirname(absoluteOwnerRoot);
  const ownerKey = path.basename(absoluteOwnerRoot);
  if (!ownerKey || path.dirname(path.join(overlayRoot, ownerKey)) !== overlayRoot) {
    throw new Error('Codex session claim owner is invalid');
  }
  const claimsRoot = ensurePrivateDirectory(
    overlayRoot,
    path.join(overlayRoot, 'session-claims'),
  );
  const claimPath = path.join(
    claimsRoot,
    `${createHash('sha256').update(sessionId, 'utf8').digest('hex')}.json`,
  );
  const claim: CodexSessionClaim = {
    version: 1,
    sessionId,
    ownerKey,
    sourceCwd,
  };
  const encoded = `${JSON.stringify(claim)}\n`;
  const created = atomicWritePrivateFile(
    overlayRoot,
    claimPath,
    encoded,
    { noOverwrite: true },
  );
  if (created) return;

  let existing: CodexSessionClaim;
  try {
    existing = JSON.parse(readPrivateFileNoFollow(
      overlayRoot,
      claimPath,
      { harden: true, maxBytes: CODEX_SESSION_CLAIM_MAX_BYTES },
    ).toString('utf8')) as CodexSessionClaim;
  } catch (error) {
    throw new Error(
      `Codex legacy session ${sessionId} has an unreadable profile claim: `
      + `${(error as Error).message}`,
    );
  }
  if (
    existing.version !== 1
    || existing.sessionId !== sessionId
    || existing.ownerKey !== ownerKey
  ) {
    throw new Error(
      `Codex legacy session ${sessionId} is already claimed by another agent`,
    );
  }
}

function removeRejectedLegacySession(
  stableRoot: string,
  destination: string,
  expected: SessionFileGeneration,
): void {
  const absolute = assertNoLinkEscape(stableRoot, destination);
  const current = fs.lstatSync(absolute);
  if (
    current.isSymbolicLink()
    || !current.isFile()
    || !sameSessionGeneration(current, expected)
  ) {
    throw new Error(
      `Codex rejected legacy session changed before safe cleanup: ${destination}`,
    );
  }
  fs.unlinkSync(absolute);
}

function preflightLegacySessionCopy(
  source: string,
  destinationRoot: string,
): fs.Stats {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(`Codex legacy session is not a regular no-follow file: ${source}`);
  }
  if (sourceStat.size > CODEX_LEGACY_SESSION_MAX_BYTES) {
    throw new Error(
      `Codex legacy session exceeds the ${CODEX_LEGACY_SESSION_MAX_BYTES}-byte migration limit`,
    );
  }
  try {
    const stats = fs.statfsSync(destinationRoot);
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (available < sourceStat.size + CODEX_LEGACY_SESSION_FREE_SPACE_RESERVE) {
      throw new Error(
        `Codex legacy session migration needs ${sourceStat.size} bytes plus reserve, `
        + `but only ${available} bytes are available`,
      );
    }
  } catch (error: any) {
    if (/Codex legacy session migration needs/.test(String(error?.message || error))) {
      throw error;
    }
    // Some filesystems do not expose statfs. The exact-file size ceiling and
    // streaming limit below still prevent an unbounded migration.
  }
  return sourceStat;
}

/**
 * One-time upgrade bridge for a specifically requested legacy runtime id.
 * The caller must first prove the runtime id belongs to this exact agent using
 * profile-owned dispatch records. This scans filenames only, copies that one
 * bounded file, and validates the published bytes before any run links them.
 */
export function migrateExactLegacyCodexSession(
  providerHome: string,
  ownerRoot: string,
  stableStateHome: string,
  sessionId: string,
  resumeAuthorization: 'agent-owned',
  copyOptions: PrivateFileCopyOptions = {},
): 'already-profile-local' | 'migrated' | 'not-found' {
  if (resumeAuthorization !== 'agent-owned') {
    throw new Error('Codex legacy session migration requires verified agent ownership');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(sessionId)) {
    throw new Error('Codex legacy session id is invalid');
  }
  const absoluteOwnerRoot = path.resolve(ownerRoot);
  const stableMatch = findExactSessionFileNoFollow(stableStateHome, sessionId);
  if (stableMatch) {
    const { sourceCwd } = assertLegacySessionIdentity(
      stableStateHome,
      stableMatch.source,
      sessionId,
    );
    claimExactLegacySession(absoluteOwnerRoot, sessionId, sourceCwd);
    return 'already-profile-local';
  }
  if (!lstatIfExists(providerHome)) return 'not-found';
  const providerRoot = canonicalProviderRoot(providerHome);
  const match = findExactSessionFileNoFollow(providerRoot, sessionId);
  if (!match) return 'not-found';
  const validatedSource = assertLegacySessionIdentity(
    providerRoot,
    match.source,
    sessionId,
  );
  claimExactLegacySession(
    absoluteOwnerRoot,
    sessionId,
    validatedSource.sourceCwd,
  );
  const sourceStat = preflightLegacySessionCopy(match.source, stableStateHome);
  if (!sameSessionGeneration(sourceStat, validatedSource.generation)) {
    throw new Error(
      `Codex legacy session changed after ownership validation: ${sessionId}`,
    );
  }
  const destination = path.join(stableStateHome, match.area, match.relative);
  ensurePrivateDirectory(absoluteOwnerRoot, path.dirname(destination));
  let copiedBytes = 0;
  const copied = copyPrivateFileNoFollow(
    providerRoot,
    match.source,
    absoluteOwnerRoot,
    destination,
    {
      ...copyOptions,
      replaceExisting: false,
      onChunk: (chunkBytes, bufferCapacity) => {
        copiedBytes += chunkBytes;
        if (copiedBytes > CODEX_LEGACY_SESSION_MAX_BYTES) {
          throw new Error(
            `Codex legacy session exceeds the ${CODEX_LEGACY_SESSION_MAX_BYTES}-byte migration limit`,
          );
        }
        copyOptions.onChunk?.(chunkBytes, bufferCapacity);
      },
    },
  );
  if (!copied && !lstatIfExists(destination)) {
    throw new Error(`Codex legacy session was not published: ${sessionId}`);
  }
  const publishedStat = fs.lstatSync(destination);
  if (publishedStat.isSymbolicLink() || !publishedStat.isFile()) {
    throw new Error(`Codex migrated session is not a regular no-follow file: ${destination}`);
  }
  const publishedGeneration: SessionFileGeneration = {
    dev: publishedStat.dev,
    ino: publishedStat.ino,
    size: publishedStat.size,
    mtimeMs: publishedStat.mtimeMs,
    ctimeMs: publishedStat.ctimeMs,
  };
  let destinationGeneration: SessionFileGeneration;
  try {
    destinationGeneration = assertLegacySessionIdentity(
      absoluteOwnerRoot,
      destination,
      sessionId,
    ).generation;
  } catch (error) {
    if (copied && lstatIfExists(destination)) {
      removeRejectedLegacySession(
        absoluteOwnerRoot,
        destination,
        publishedGeneration,
      );
    }
    throw error;
  }
  if (!lstatIfExists(destination) || !sameSessionGeneration(
    fs.lstatSync(destination),
    destinationGeneration,
  )) {
    throw new Error(`Codex migrated session changed before run publication: ${sessionId}`);
  }
  if (copied) {
    try {
      fs.utimesSync(destination, sourceStat.atime, sourceStat.mtime);
    } catch { /* timestamp preservation is best effort */ }
  }
  return copied ? 'migrated' : 'already-profile-local';
}

function copyProviderTreeNoFollow(
  providerRoot: string,
  source: string,
  destinationRoot: string,
  destination: string,
  copyOptions: PrivateFileCopyOptions,
): void {
  const sourceStat = verifiedProviderSource(providerRoot, source);
  if (sourceStat.isFile()) {
    const destinationStat = lstatIfExists(destination);
    if (destinationStat) {
      if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
        throw new Error(`Codex provider fallback file is unsafe: ${destination}`);
      }
      // Cross-volume/non-elevated Windows falls back to a profile-owned copy.
      // Reconcile a newer source entry without using unbounded whole-file reads.
      if (sourceStat.mtimeMs > destinationStat.mtimeMs) {
        copyPrivateFileNoFollow(
          providerRoot,
          source,
          destinationRoot,
          destination,
          { ...copyOptions, replaceExisting: true },
        );
        try {
          fs.utimesSync(destination, sourceStat.atime, sourceStat.mtime);
        } catch { /* timestamp preservation is best effort */ }
      }
      return;
    }
    copyPrivateFileNoFollow(
      providerRoot,
      source,
      destinationRoot,
      destination,
      copyOptions,
    );
    try {
      fs.utimesSync(destination, sourceStat.atime, sourceStat.mtime);
    } catch { /* timestamp preservation is best effort */ }
    return;
  }

  ensurePrivateDirectory(destinationRoot, destination);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Codex provider directory contains a symlink: ${path.join(source, entry.name)}`);
    }
    if (!entry.isFile() && !entry.isDirectory()) {
      throw new Error(`Codex provider directory contains an unsupported entry: ${path.join(source, entry.name)}`);
    }
    copyProviderTreeNoFollow(
      providerRoot,
      path.join(source, entry.name),
      destinationRoot,
      path.join(destination, entry.name),
      copyOptions,
    );
  }
}

function preflightProviderCopy(
  providerRoot: string,
  source: string,
  destinationRoot: string,
): void {
  let files = 0;
  let bytes = 0;
  const visit = (entryPath: string): void => {
    const stat = verifiedProviderSource(providerRoot, entryPath);
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
      if (
        files > CODEX_PROVIDER_COPY_MAX_FILES
        || bytes > CODEX_PROVIDER_COPY_MAX_BYTES
      ) {
        throw new Error(
          `Codex provider copy fallback exceeds the safe limit `
          + `(${CODEX_PROVIDER_COPY_MAX_FILES} files / `
          + `${CODEX_PROVIDER_COPY_MAX_BYTES} bytes); a verified directory link is required`,
        );
      }
      return;
    }
    for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw new Error(`Codex provider directory contains an unsafe entry: ${path.join(entryPath, entry.name)}`);
      }
      visit(path.join(entryPath, entry.name));
    }
  };
  visit(source);

  try {
    const stats = fs.statfsSync(destinationRoot);
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (available < bytes + CODEX_PROVIDER_COPY_FREE_SPACE_RESERVE) {
      throw new Error(
        `Codex provider copy fallback needs ${bytes} bytes plus reserve, `
        + `but only ${available} bytes are available`,
      );
    }
  } catch (error: any) {
    if (/Codex provider copy fallback needs/.test(String(error?.message || error))) throw error;
    // statfs is unavailable on some filesystems; the strict size/file ceiling
    // still prevents unbounded silent duplication.
  }
}

/**
 * Materialize one explicitly reviewed provider entry. Windows uses hard links
 * for files and directory junctions without requiring elevation; every failure
 * falls back to a verified profile-owned copy.
 */
export function materializeCodexProviderEntry(
  providerHome: string,
  entryName: string,
  destinationRoot: string,
  destinationHome: string,
  mode: ProviderSharingMode = 'auto',
  copyOptions: PrivateFileCopyOptions = {},
): ProviderEntryMaterialization | null {
  const providerRoot = canonicalProviderRoot(providerHome);
  const source = path.join(providerRoot, entryName);
  if (!lstatIfExists(source)) return null;
  const sourceStat = verifiedProviderSource(providerRoot, source);
  ensurePrivateDirectory(destinationRoot, destinationHome);
  const destination = path.join(destinationHome, entryName);
  assertNoLinkEscape(destinationRoot, path.dirname(destination));

  const existing = lstatIfExists(destination);
  if (existing) {
    if (existing.isSymbolicLink()) {
      if (!verifySharedLink(source, destination)) {
        throw new Error(`Codex provider link points to an unexpected target: ${destination}`);
      }
      return process.platform === 'win32' && sourceStat.isDirectory() ? 'junction' : 'symlink';
    }
    if (sourceStat.isFile() && existing.isFile()) {
      const sourceIdentity = fs.statSync(source);
      const destinationIdentity = fs.statSync(destination);
      if (
        sourceIdentity.dev === destinationIdentity.dev
        && sourceIdentity.ino === destinationIdentity.ino
      ) {
        return 'hardlink';
      }
      // Preparation is provider-to-run only. OAuth refreshes are reconciled
      // after the exact child has stopped, using launch generations so a stale
      // overlay cannot overwrite a concurrent provider change or logout.
      preflightProviderCopy(providerRoot, source, destinationRoot);
      copyPrivateFileNoFollow(
        providerRoot,
        source,
        destinationRoot,
        destination,
        { ...copyOptions, replaceExisting: true },
      );
      try {
        fs.utimesSync(destination, sourceIdentity.atime, sourceIdentity.mtime);
      } catch { /* timestamp preservation is best effort */ }
      return 'copy';
    }
    if (sourceStat.isDirectory() && existing.isDirectory()) {
      preflightProviderCopy(providerRoot, source, destinationRoot);
      copyProviderTreeNoFollow(
        providerRoot,
        source,
        destinationRoot,
        destination,
        copyOptions,
      );
      return 'copy';
    }
    throw new Error(`Codex provider destination has the wrong type: ${destination}`);
  }

  if (mode === 'auto') {
    if (sourceStat.isFile()) {
      try {
        fs.linkSync(source, destination);
        const sourceIdentity = fs.statSync(source);
        const destinationIdentity = fs.statSync(destination);
        if (
          sourceIdentity.dev === destinationIdentity.dev
          && sourceIdentity.ino === destinationIdentity.ino
        ) {
          return 'hardlink';
        }
        fs.unlinkSync(destination);
      } catch {
        try { fs.unlinkSync(destination); } catch { /* absent */ }
      }
    } else {
      try {
        fs.symlinkSync(
          source,
          destination,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        if (verifySharedLink(source, destination)) {
          return process.platform === 'win32' ? 'junction' : 'symlink';
        }
        fs.unlinkSync(destination);
      } catch {
        try { fs.unlinkSync(destination); } catch { /* absent */ }
      }
    }
  }

  preflightProviderCopy(providerRoot, source, destinationRoot);
  copyProviderTreeNoFollow(
    providerRoot,
    source,
    destinationRoot,
    destination,
    copyOptions,
  );
  const materialized = fs.lstatSync(destination);
  if (sourceStat.isFile() ? !materialized.isFile() : !materialized.isDirectory()) {
    throw new Error(`Codex provider fallback was not materialized: ${destination}`);
  }
  return 'copy';
}

export interface CodexAuthFileGeneration {
  present: boolean;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  sha256?: string;
}

export interface CodexAuthReconciliation {
  providerRoot: string;
  providerAuth: string;
  runRoot: string;
  runAuth: string;
  launchProvider: CodexAuthFileGeneration;
  launchRun: CodexAuthFileGeneration;
  copyOptions?: PrivateFileCopyOptions;
}

export type CodexAuthReconciliationResult =
  | 'unchanged'
  | 'shared-update'
  | 'provider-logout'
  | 'provider-conflict'
  | 'run-refresh';

function sameGeneration(
  left: CodexAuthFileGeneration,
  right: CodexAuthFileGeneration,
): boolean {
  if (left.present !== right.present) return false;
  if (!left.present) return true;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.sha256 === right.sha256;
}

function sameContents(
  left: CodexAuthFileGeneration,
  right: CodexAuthFileGeneration,
): boolean {
  if (left.present !== right.present) return false;
  if (!left.present) return true;
  return left.size === right.size && left.sha256 === right.sha256;
}

/** Capture a bounded, no-follow content generation for auth.json. */
function authFileGeneration(root: string, authPath: string): CodexAuthFileGeneration {
  const stat = lstatIfExists(authPath);
  if (!stat) return { present: false };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Codex auth entry is not a regular no-follow file: ${authPath}`);
  }
  if (stat.size > CODEX_AUTH_MAX_BYTES) {
    throw new Error(`Codex auth entry exceeds the ${CODEX_AUTH_MAX_BYTES}-byte safety limit`);
  }
  const absolute = assertNoLinkEscape(root, authPath);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > CODEX_AUTH_MAX_BYTES) {
      throw new Error(`Codex auth entry changed type or exceeded its safety limit: ${authPath}`);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const bytes = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (bytes <= 0) {
        throw new Error(`Codex auth entry changed during generation capture: ${authPath}`);
      }
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`Codex auth entry changed during generation capture: ${authPath}`);
    }
    return {
      present: true,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      sha256: hash.digest('hex'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function captureCodexAuthReconciliation(
  providerHome: string,
  runRoot: string,
  runHome: string,
  copyOptions: PrivateFileCopyOptions = {},
): CodexAuthReconciliation | undefined {
  if (!lstatIfExists(providerHome)) return undefined;
  const providerRoot = canonicalProviderRoot(providerHome);
  const absoluteRunRoot = path.resolve(runRoot);
  const providerAuth = path.join(providerRoot, 'auth.json');
  const runAuth = path.join(runHome, 'auth.json');
  return {
    providerRoot,
    providerAuth,
    runRoot: absoluteRunRoot,
    runAuth,
    launchProvider: authFileGeneration(providerRoot, providerAuth),
    launchRun: authFileGeneration(absoluteRunRoot, runAuth),
    copyOptions,
  };
}

/**
 * Reconcile only auth.json after the exact Codex child is quiescent.
 *
 * Provider deletion is authoritative. A provider generation that changed
 * independently during the run wins over a divergent run copy. Existing
 * provider auth is never replaced or deleted from an isolated copy: external
 * `codex login/logout` does not participate in Manager locking, and portable
 * filesystems do not provide a conditional rename/unlink primitive. A first
 * login may still be published with an atomic create-if-absent.
 */
export function reconcileCodexAuthAfterRun(
  snapshot: CodexAuthReconciliation,
): CodexAuthReconciliationResult {
  const providerNow = authFileGeneration(snapshot.providerRoot, snapshot.providerAuth);
  const runNow = authFileGeneration(snapshot.runRoot, snapshot.runAuth);

  if (snapshot.launchProvider.present && !providerNow.present) {
    removeMaterializedCodexProviderFile(
      snapshot.runRoot,
      path.dirname(snapshot.runAuth),
      path.basename(snapshot.runAuth),
    );
    return 'provider-logout';
  }

  const providerChanged = !sameGeneration(providerNow, snapshot.launchProvider);
  const runChanged = !sameGeneration(runNow, snapshot.launchRun);
  if (providerChanged) {
    return sameContents(providerNow, runNow) ? 'shared-update' : 'provider-conflict';
  }
  if (!runChanged) return 'unchanged';

  // Fail closed for an isolated run that diverged from an existing provider
  // generation. A check followed by replace/unlink would still race an
  // unrelated provider-side Codex process between those two operations.
  if (snapshot.launchProvider.present) return 'provider-conflict';
  if (!runNow.present) return 'unchanged';

  // First-login publication is safe: publication is an atomic create. If an
  // external process logs in after this check, its provider auth wins.
  const current = authFileGeneration(snapshot.providerRoot, snapshot.providerAuth);
  if (!sameGeneration(current, snapshot.launchProvider)) return 'provider-conflict';
  const published = copyPrivateFileNoFollow(
    snapshot.runRoot,
    snapshot.runAuth,
    snapshot.providerRoot,
    snapshot.providerAuth,
    {
      ...snapshot.copyOptions,
      replaceExisting: false,
    },
  );
  if (!published) return 'provider-conflict';
  return 'run-refresh';
}

/**
 * Delete one generated run home without following final or nested links.
 * The caller supplies the exact trusted runs root, never a broad profile path.
 */
export function removeCodexRunHomeNoFollow(runsRoot: string, runHome: string): void {
  const absoluteRunsRoot = path.resolve(runsRoot);
  const canonicalRunsRoot = fs.realpathSync(absoluteRunsRoot);
  const target = path.resolve(runHome);
  if (!pathIsWithin(absoluteRunsRoot, target) || target === absoluteRunsRoot) {
    throw new Error(`Codex run cleanup target escapes its runs root: ${target}`);
  }

  const removeEntry = (entryPath: string): void => {
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(entryPath);
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Codex run cleanup found an unsupported entry: ${entryPath}`);
    }
    const canonical = fs.realpathSync(entryPath);
    if (!pathIsWithin(canonicalRunsRoot, canonical)) {
      throw new Error(`Codex run cleanup directory escapes its root: ${entryPath}`);
    }
    for (const name of fs.readdirSync(entryPath)) {
      removeEntry(path.join(entryPath, name));
    }
    fs.rmdirSync(entryPath);
  };

  if (lstatIfExists(target)) removeEntry(target);
}

/** Remove one manifest-owned provider file without following its final link. */
export function removeMaterializedCodexProviderFile(
  destinationRoot: string,
  destinationHome: string,
  entryName: string,
): boolean {
  ensurePrivateDirectory(destinationRoot, destinationHome);
  assertNoLinkEscape(destinationRoot, path.dirname(path.join(destinationHome, entryName)));
  const destination = path.join(destinationHome, entryName);
  const stat = lstatIfExists(destination);
  if (!stat) return false;
  if (!stat.isSymbolicLink() && !stat.isFile()) {
    throw new Error(`manifest-owned Codex provider entry has the wrong type: ${destination}`);
  }
  fs.unlinkSync(destination);
  return true;
}
