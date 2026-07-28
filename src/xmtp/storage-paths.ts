// SPDX-License-Identifier: MIT

import os from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs';
import {
  assertNoLinkEscape,
  atomicWritePrivateFile,
  copyPrivateFileNoFollow,
  ensurePrivateDirectory,
  lstatIfExists,
  nearestExistingDirectory,
  pathIsWithin,
  readPrivateFileNoFollow,
} from '../lib/profile-storage.js';

export interface XmtpStorageConfig {
  dbPath?: string;
  workingDirectory?: string;
  /** Exact pre-profile agent workspace used by older Manager releases. */
  legacyWorkingDirectory?: string;
  /** Port used by the older OWS `<network>-<port>.db3` layout. */
  legacyPort?: number;
}

export interface XmtpStoragePaths {
  /** Profile-owned directory for the wallet's encryption key and allowlist. */
  dataDir: string;
  /** Exact SQLite path passed to the XMTP SDK. */
  dbPath: string;
  /** Profile-owned DB encryption key path. */
  dbEncryptionKeyPath: string;
  /** Profile-owned sender allowlist path. */
  allowlistPath: string;
  /** Trusted root for key/allowlist/marker operations. */
  dataBoundaryRoot: string;
  /** Trusted root for database and sidecar operations. */
  dbBoundaryRoot: string;
  /** Versioned one-time legacy migration marker. */
  legacyMigrationMarkerPath: string;
}

export interface XmtpStorageContext {
  env?: NodeJS.ProcessEnv;
  /** Injectable current OS home used for migration tests. */
  homeDirectory?: string;
  /** Exact pre-profile agent workspace used by older Manager releases. */
  legacyWorkingDirectory?: string;
  /** Port used by the older OWS `<network>-<port>.db3` layout. */
  legacyPort?: number;
  /** Explicit raw-key database encryption key used by createFromEnv. */
  dbEncryptionKey?: string;
  /** Raw-key mode keeps address-home migration to allowlist state only. */
  includeAddressDatabase?: boolean;
}

function configuredPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

/** Create and harden every directory that can contain profile-owned XMTP data. */
export function ensureXmtpStoragePrivacy(paths: XmtpStoragePaths): void {
  ensurePrivateDirectory(paths.dataBoundaryRoot, paths.dataDir);
  ensurePrivateDirectory(paths.dbBoundaryRoot, path.dirname(paths.dbPath));
}

/** Write a key/allowlist and force owner-only mode, including retained files. */
export function writePrivateXmtpFile(
  paths: XmtpStoragePaths,
  filePath: string,
  contents: string,
): void {
  atomicWritePrivateFile(paths.dataBoundaryRoot, filePath, contents);
}

/** Harden a retained private file before reading it. */
export function hardenPrivateXmtpFile(paths: XmtpStoragePaths, filePath: string): void {
  if (!lstatIfExists(filePath)) return;
  readPrivateFileNoFollow(paths.dataBoundaryRoot, filePath, { harden: true });
}

export function readPrivateXmtpFile(paths: XmtpStoragePaths, filePath: string): Buffer {
  return readPrivateFileNoFollow(paths.dataBoundaryRoot, filePath, { harden: true });
}

const LEGACY_MIGRATION_VERSION = 1;
const RAW_LEGACY_MIGRATION_VERSION = 1;
const DATABASE_SIDECAR_SUFFIXES = Object.freeze([
  '-wal',
  '-shm',
  '-journal',
  '.sqlcipher_salt',
]);

export interface XmtpLegacyMigrationResult {
  version: number;
  status: 'already-complete' | 'not-found' | 'migrated';
  copied: string[];
}

export type XmtpRawDatabaseEncryptionMode =
  | 'profile-key'
  | 'unencrypted'
  | null;

export interface XmtpRawLegacyMigrationResult extends XmtpLegacyMigrationResult {
  inboxId: string;
  encryptionMode: XmtpRawDatabaseEncryptionMode;
}

interface LegacyCopyCandidate {
  name: string;
  sourceRoot: string;
  source: string;
  destinationRoot: string;
  destination: string;
}

function canonicalConfiguredRoot(candidate: string): string | undefined {
  const absolute = path.resolve(candidate);
  const stat = lstatIfExists(absolute);
  if (!stat) return undefined;
  const canonical = fs.realpathSync(absolute);
  const canonicalStat = fs.lstatSync(canonical);
  if (canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory()) {
    throw new Error(`legacy XMTP root is unsafe: ${absolute}`);
  }
  return canonical;
}

function regularLegacyFile(root: string, filePath: string): string | undefined {
  const stat = lstatIfExists(filePath);
  if (!stat) return undefined;
  assertNoLinkEscape(root, filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`legacy XMTP file is unsafe: ${filePath}`);
  }
  return filePath;
}

function legacyFileFamily(
  root: string,
  databasePath: string,
): Map<string, string> | undefined {
  const database = regularLegacyFile(root, databasePath);
  if (!database) return undefined;
  const family = new Map<string, string>([['', database]]);
  for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
    const member = regularLegacyFile(root, `${databasePath}${suffix}`);
    if (member) family.set(suffix, member);
  }
  return family;
}

function privateFilesEqual(
  leftRoot: string,
  leftPath: string,
  rightRoot: string,
  rightPath: string,
): boolean {
  const left = regularLegacyFile(leftRoot, leftPath);
  const right = regularLegacyFile(rightRoot, rightPath);
  if (!left || !right) return false;
  if (fs.statSync(left).size !== fs.statSync(right).size) return false;

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const leftBefore = fs.lstatSync(left);
  const rightBefore = fs.lstatSync(right);
  let leftFd: number | undefined;
  let rightFd: number | undefined;
  const leftBuffer = Buffer.allocUnsafe(64 * 1024);
  const rightBuffer = Buffer.allocUnsafe(64 * 1024);
  const assertOpened = (
    root: string,
    filePath: string,
    before: fs.Stats,
    fd: number,
  ): void => {
    assertNoLinkEscape(root, filePath);
    const opened = fs.fstatSync(fd);
    const after = fs.lstatSync(filePath);
    if (
      after.isSymbolicLink()
      || !opened.isFile()
      || before.dev !== opened.dev
      || before.ino !== opened.ino
      || opened.dev !== after.dev
      || opened.ino !== after.ino
    ) {
      throw new Error(`legacy XMTP file changed during comparison: ${filePath}`);
    }
  };
  try {
    leftFd = fs.openSync(left, fs.constants.O_RDONLY | noFollow);
    rightFd = fs.openSync(right, fs.constants.O_RDONLY | noFollow);
    assertOpened(leftRoot, left, leftBefore, leftFd);
    assertOpened(rightRoot, right, rightBefore, rightFd);
    let equal = true;
    while (true) {
      const leftBytes = fs.readSync(leftFd, leftBuffer, 0, leftBuffer.length, null);
      const rightBytes = fs.readSync(rightFd, rightBuffer, 0, rightBuffer.length, null);
      if (leftBytes !== rightBytes) {
        equal = false;
        break;
      }
      if (leftBytes === 0) break;
      if (!leftBuffer.subarray(0, leftBytes).equals(rightBuffer.subarray(0, rightBytes))) {
        equal = false;
        break;
      }
    }
    assertOpened(leftRoot, left, leftBefore, leftFd);
    assertOpened(rightRoot, right, rightBefore, rightFd);
    return equal;
  } finally {
    if (leftFd !== undefined) fs.closeSync(leftFd);
    if (rightFd !== undefined) fs.closeSync(rightFd);
  }
}

function validateCoherentLegacyCandidates(
  candidates: LegacyCopyCandidate[],
  destinationFamily: string[],
): void {
  const expectedDestinations = new Set(candidates.map((candidate) => path.resolve(candidate.destination)));
  for (const destination of destinationFamily) {
    const existing = lstatIfExists(destination);
    if (!existing) continue;
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`profile XMTP migration destination is unsafe: ${destination}`);
    }
    if (!expectedDestinations.has(path.resolve(destination))) {
      throw new Error(
        `profile XMTP database already has a conflicting bundle member: ${destination}`,
      );
    }
  }

  for (const candidate of candidates) {
    if (
      lstatIfExists(candidate.destination)
      && !privateFilesEqual(
        candidate.sourceRoot,
        candidate.source,
        candidate.destinationRoot,
        candidate.destination,
      )
    ) {
      throw new Error(
        `profile XMTP database conflicts with the retained legacy bundle: ${candidate.destination}`,
      );
    }
  }
}

function copyCoherentLegacyCandidates(
  candidates: LegacyCopyCandidate[],
  destinationFamily: string[],
): string[] {
  validateCoherentLegacyCandidates(candidates, destinationFamily);

  const copied: string[] = [];
  for (const candidate of candidates) {
    const published = copyPrivateFileNoFollow(
      candidate.sourceRoot,
      candidate.source,
      candidate.destinationRoot,
      candidate.destination,
    );
    if (published) {
      copied.push(candidate.name);
    } else if (!privateFilesEqual(
      candidate.sourceRoot,
      candidate.source,
      candidate.destinationRoot,
      candidate.destination,
    )) {
      throw new Error(`profile XMTP migration raced with another writer: ${candidate.destination}`);
    }
  }
  return copied;
}

function relevantLegacyHome(
  canonicalHome: string,
  address: string,
  network: 'local' | 'dev' | 'production',
): { root: string; directory: string } | undefined {
  const directory = path.join(canonicalHome, '.xmtp', address);
  const stat = lstatIfExists(directory);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`legacy XMTP directory is unsafe: ${directory}`);
  }
  assertNoLinkEscape(canonicalHome, directory);
  const relevantNames = [
    'db.key',
    'allowlist.yaml',
    `${network}.db3`,
    ...DATABASE_SIDECAR_SUFFIXES.map((suffix) => `${network}.db3${suffix}`),
  ];
  const relevant = relevantNames.some((name) => {
    const candidate = path.join(directory, name);
    const candidateStat = lstatIfExists(candidate);
    if (!candidateStat) return false;
    regularLegacyFile(directory, candidate);
    return true;
  });
  return relevant ? { root: fs.realpathSync(directory), directory } : undefined;
}

function resolveLegacyHomeSource(
  address: string,
  network: 'local' | 'dev' | 'production',
  context: XmtpStorageContext,
): { root: string; directory: string } | undefined {
  const env = context.env ?? process.env;
  // Preserve both exact historical semantics (HOME || "/tmp") and the
  // os.homedir()-based path probed by intermediate profile-aware builds.
  const homeCandidates = [
    env.HOME?.trim() || '/tmp',
    context.homeDirectory ?? os.homedir(),
  ];
  const sources: Array<{ root: string; directory: string }> = [];
  const seen = new Set<string>();
  for (const home of homeCandidates) {
    const canonicalHome = canonicalConfiguredRoot(home);
    if (!canonicalHome || seen.has(canonicalHome)) continue;
    seen.add(canonicalHome);
    const source = relevantLegacyHome(canonicalHome, address, network);
    if (source) sources.push(source);
  }
  if (sources.length > 1) {
    throw new Error('multiple legacy XMTP HOME directories contain state; migration is ambiguous');
  }
  return sources[0];
}

function resolveLegacyOwsDatabase(
  network: 'local' | 'dev' | 'production',
  context: XmtpStorageContext,
): { root: string; databasePath: string } | undefined {
  const configuredWorkspace = context.legacyWorkingDirectory?.trim();
  if (!configuredWorkspace) return undefined;
  const workspaceRoot = canonicalConfiguredRoot(configuredWorkspace);
  if (!workspaceRoot) return undefined;
  const directory = path.join(workspaceRoot, '.xmtp');
  const directoryStat = lstatIfExists(directory);
  if (!directoryStat) return undefined;
  assertNoLinkEscape(workspaceRoot, directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`legacy XMTP database directory is unsafe: ${directory}`);
  }

  const pattern = new RegExp(`^${network}-(\\d+)\\.db3$`);
  const matches: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!pattern.test(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`legacy XMTP database file is unsafe: ${candidate}`);
    }
    regularLegacyFile(directory, candidate);
    matches.push(candidate);
  }
  const expected = Number.isInteger(context.legacyPort)
    ? path.join(directory, `${network}-${context.legacyPort}.db3`)
    : undefined;
  if (expected && matches.includes(expected)) {
    return { root: fs.realpathSync(directory), databasePath: expected };
  }
  if (matches.length > 1) {
    throw new Error('multiple legacy port-keyed XMTP databases exist; migration is ambiguous');
  }
  if (matches.length === 0) return undefined;
  // Port changes retain the sole old database when the exact current-port path
  // is absent; multiple wildcard candidates are rejected above.
  return { root: fs.realpathSync(directory), databasePath: matches[0] };
}

/**
 * Copy exact legacy HOME files into profile storage once. Sources are never
 * followed through symlinks/junctions and are retained for rollback.
 */
export function migrateLegacyXmtpStorage(
  paths: XmtpStoragePaths,
  address: string,
  network: 'local' | 'dev' | 'production',
  context: XmtpStorageContext = {},
): XmtpLegacyMigrationResult {
  const env = context.env ?? process.env;
  if (env.IDACC_MANAGED_SERVICE !== '1' && !env.IDACC_DATA_DIR?.trim()) {
    return { version: LEGACY_MIGRATION_VERSION, status: 'not-found', copied: [] };
  }

  ensureXmtpStoragePrivacy(paths);
  if (lstatIfExists(paths.legacyMigrationMarkerPath)) {
    const marker = JSON.parse(readPrivateFileNoFollow(
      paths.dataBoundaryRoot,
      paths.legacyMigrationMarkerPath,
      { harden: true },
    ).toString('utf8'));
    if (marker?.version !== LEGACY_MIGRATION_VERSION) {
      throw new Error('legacy XMTP migration marker is invalid');
    }
    if (marker?.network !== network) {
      throw new Error('legacy XMTP migration marker network is invalid');
    }
    return { version: LEGACY_MIGRATION_VERSION, status: 'already-complete', copied: [] };
  }

  const normalizedAddress = address.trim().toLowerCase();
  const homeSource = resolveLegacyHomeSource(normalizedAddress, network, context);
  const homeDatabasePath = context.includeAddressDatabase !== false && homeSource
    ? path.join(homeSource.root, `${network}.db3`)
    : undefined;
  const homeDatabase = homeDatabasePath
    ? legacyFileFamily(homeSource!.root, homeDatabasePath)
    : undefined;
  const workspaceDatabase = context.includeAddressDatabase === false
    ? undefined
    : resolveLegacyOwsDatabase(network, context);
  const workspaceFamily = workspaceDatabase
    ? legacyFileFamily(workspaceDatabase.root, workspaceDatabase.databasePath)
    : undefined;
  if (homeDatabase && workspaceFamily) {
    throw new Error('multiple legacy XMTP databases exist; migration is ambiguous');
  }
  const databaseRoot = workspaceFamily ? workspaceDatabase!.root : homeSource?.root;
  const databasePath = workspaceFamily
    ? workspaceDatabase!.databasePath
    : homeDatabasePath;
  const databaseFamily = workspaceFamily ?? homeDatabase;
  const copied: string[] = [];

  const allowlist = homeSource
    ? regularLegacyFile(homeSource.root, path.join(homeSource.root, 'allowlist.yaml'))
    : undefined;
  if (allowlist && copyPrivateFileNoFollow(
    homeSource!.root,
    allowlist,
    paths.dataBoundaryRoot,
    paths.allowlistPath,
  )) {
    copied.push('allowlist.yaml');
  }

  if (databaseFamily && databaseRoot && databasePath) {
    const legacyKey = homeSource
      ? regularLegacyFile(homeSource.root, path.join(homeSource.root, 'db.key'))
      : undefined;
    if (!legacyKey || !databaseFamily.has('.sqlcipher_salt')) {
      throw new Error(
        'legacy XMTP database bundle is incomplete; db.key and sqlcipher salt are required',
      );
    }
    const candidates: LegacyCopyCandidate[] = [
      {
        name: 'db.key',
        sourceRoot: homeSource!.root,
        source: legacyKey,
        destinationRoot: paths.dataBoundaryRoot,
        destination: paths.dbEncryptionKeyPath,
      },
    ];
    for (const [suffix, source] of databaseFamily) {
      candidates.push({
        name: `${network}.db3${suffix}`,
        sourceRoot: databaseRoot,
        source,
        destinationRoot: paths.dbBoundaryRoot,
        destination: `${paths.dbPath}${suffix}`,
      });
    }
    const destinationFamily = [
      paths.dbEncryptionKeyPath,
      paths.dbPath,
      ...DATABASE_SIDECAR_SUFFIXES.map((suffix) => `${paths.dbPath}${suffix}`),
    ];
    const coherentCopied = copyCoherentLegacyCandidates(candidates, destinationFamily);
    // Preserve the established public result ordering.
    if (coherentCopied.includes('db.key')) copied.unshift('db.key');
    copied.push(...coherentCopied.filter((name) => name !== 'db.key'));
  }

  const status = (allowlist || databaseFamily) ? 'migrated' : 'not-found';
  atomicWritePrivateFile(
    paths.dataBoundaryRoot,
    paths.legacyMigrationMarkerPath,
    `${JSON.stringify({
      version: LEGACY_MIGRATION_VERSION,
      network,
      status,
      copied,
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { noOverwrite: true },
  );
  return { version: LEGACY_MIGRATION_VERSION, status, copied };
}

function normalizeDatabaseKey(key: string | undefined): string | undefined {
  const normalized = key?.trim().replace(/^0x/, '');
  if (!normalized) return undefined;
  if (!/^[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error('XMTP database encryption key must contain exactly 32 bytes of hex');
  }
  return normalized.toLowerCase();
}

function rawLegacyMarkerPath(
  paths: XmtpStoragePaths,
  inboxId: string,
  network: 'local' | 'dev' | 'production',
): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(inboxId)) {
    throw new Error('XMTP inbox id is invalid for legacy migration');
  }
  return path.join(
    paths.dataDir,
    `.legacy-raw-migration-v${RAW_LEGACY_MIGRATION_VERSION}-${network}-${inboxId}.json`,
  );
}

function inferProfileRawEncryptionMode(
  paths: XmtpStoragePaths,
): XmtpRawDatabaseEncryptionMode {
  if (!lstatIfExists(paths.dbPath)) return null;
  regularLegacyFile(paths.dbBoundaryRoot, paths.dbPath);
  const salt = regularLegacyFile(paths.dbBoundaryRoot, `${paths.dbPath}.sqlcipher_salt`);
  const key = regularLegacyFile(paths.dataBoundaryRoot, paths.dbEncryptionKeyPath);
  if (salt && key) return 'profile-key';
  if (!salt && !key) return 'unencrypted';
  throw new Error('profile XMTP raw database has inconsistent encryption metadata');
}

/**
 * Migrate the exact database family created by the old raw-key
 * Agent.createFromEnv path. The SDK-provided inbox id makes discovery bounded
 * to one filename; no wildcard-selected installation is ever imported.
 */
export function migrateLegacyRawXmtpStorage(
  paths: XmtpStoragePaths,
  inboxId: string,
  network: 'local' | 'dev' | 'production',
  context: XmtpStorageContext = {},
): XmtpRawLegacyMigrationResult {
  ensureXmtpStoragePrivacy(paths);
  const markerPath = rawLegacyMarkerPath(paths, inboxId, network);
  if (lstatIfExists(markerPath)) {
    const marker = JSON.parse(readPrivateFileNoFollow(
      paths.dataBoundaryRoot,
      markerPath,
      { harden: true },
    ).toString('utf8'));
    if (
      marker?.version !== RAW_LEGACY_MIGRATION_VERSION
      || marker?.network !== network
      || marker?.inboxId !== inboxId
      || !['profile-key', 'unencrypted', null].includes(marker?.encryptionMode)
    ) {
      throw new Error('legacy raw XMTP migration marker is invalid');
    }
    if (marker.encryptionMode === 'profile-key') {
      if (inferProfileRawEncryptionMode(paths) !== 'profile-key') {
        throw new Error('migrated raw XMTP encryption bundle is incomplete');
      }
      const configuredKey = normalizeDatabaseKey(context.dbEncryptionKey);
      if (configuredKey) {
        const retained = readPrivateFileNoFollow(
          paths.dataBoundaryRoot,
          paths.dbEncryptionKeyPath,
          { harden: true },
        ).toString('utf8').trim().replace(/^0x/, '').toLowerCase();
        if (retained !== configuredKey) {
          throw new Error('configured XMTP database key conflicts with the migrated raw key');
        }
      }
    } else if (
      marker.encryptionMode === 'unencrypted'
      && (
        normalizeDatabaseKey(context.dbEncryptionKey)
        || inferProfileRawEncryptionMode(paths) !== 'unencrypted'
      )
    ) {
      throw new Error('migrated raw XMTP database is unencrypted and cannot accept a profile key');
    }
    return {
      version: RAW_LEGACY_MIGRATION_VERSION,
      status: 'already-complete',
      copied: [],
      inboxId,
      encryptionMode: marker.encryptionMode,
    };
  }

  const env = context.env ?? process.env;
  const configuredDirectory = env.XMTP_DB_DIRECTORY?.trim();
  const legacyRootPath = configuredDirectory
    || context.legacyWorkingDirectory?.trim()
    || process.cwd();
  const legacyRoot = canonicalConfiguredRoot(legacyRootPath);
  const legacyName = configuredDirectory
    ? `xmtp-${inboxId}.db3`
    : `xmtp-${network}-${inboxId}.db3`;
  const sourceDatabasePath = legacyRoot
    ? path.join(legacyRoot, legacyName)
    : undefined;
  const sourceFamily = sourceDatabasePath
    ? legacyFileFamily(legacyRoot!, sourceDatabasePath)
    : undefined;
  const copied: string[] = [];
  let encryptionMode: XmtpRawDatabaseEncryptionMode = null;

  if (sourceFamily && sourceDatabasePath && legacyRoot) {
    const explicitKey = normalizeDatabaseKey(context.dbEncryptionKey);
    const hasSalt = sourceFamily.has('.sqlcipher_salt');
    if (hasSalt !== Boolean(explicitKey)) {
      throw new Error(
        hasSalt
          ? 'encrypted legacy raw XMTP database requires its explicit encryption key'
          : 'legacy raw XMTP database has a key but no sqlcipher salt',
      );
    }
    encryptionMode = explicitKey ? 'profile-key' : 'unencrypted';

    const candidates: LegacyCopyCandidate[] = [];
    for (const [suffix, source] of sourceFamily) {
      candidates.push({
        name: `${legacyName}${suffix}`,
        sourceRoot: legacyRoot,
        source,
        destinationRoot: paths.dbBoundaryRoot,
        destination: `${paths.dbPath}${suffix}`,
      });
    }
    const destinationFamily = [
      paths.dbPath,
      ...DATABASE_SIDECAR_SUFFIXES.map((suffix) => `${paths.dbPath}${suffix}`),
    ];
    // Validate every DB/salt/sidecar destination before publishing a migrated
    // key, so a conflict cannot leave a misleading partial encryption bundle.
    validateCoherentLegacyCandidates(candidates, destinationFamily);

    if (explicitKey) {
      const existingKey = lstatIfExists(paths.dbEncryptionKeyPath);
      if (existingKey) {
        const retained = readPrivateFileNoFollow(
          paths.dataBoundaryRoot,
          paths.dbEncryptionKeyPath,
          { harden: true },
        ).toString('utf8').trim().replace(/^0x/, '').toLowerCase();
        if (retained !== explicitKey) {
          throw new Error('profile XMTP database key conflicts with the legacy raw key');
        }
      } else {
        const published = atomicWritePrivateFile(
          paths.dataBoundaryRoot,
          paths.dbEncryptionKeyPath,
          explicitKey,
          { noOverwrite: true },
        );
        const retained = readPrivateFileNoFollow(
          paths.dataBoundaryRoot,
          paths.dbEncryptionKeyPath,
          { harden: true },
        ).toString('utf8').trim().replace(/^0x/, '').toLowerCase();
        if (retained !== explicitKey) {
          throw new Error('profile XMTP database key raced with the legacy raw key');
        }
        if (published) copied.push('db.key');
      }
    } else if (lstatIfExists(paths.dbEncryptionKeyPath)) {
      throw new Error('unencrypted legacy raw XMTP database conflicts with a profile key');
    }

    copied.push(...copyCoherentLegacyCandidates(candidates, destinationFamily));
  } else {
    encryptionMode = inferProfileRawEncryptionMode(paths);
  }

  const status = sourceFamily ? 'migrated' : 'not-found';
  atomicWritePrivateFile(
    paths.dataBoundaryRoot,
    markerPath,
    `${JSON.stringify({
      version: RAW_LEGACY_MIGRATION_VERSION,
      network,
      inboxId,
      status,
      copied,
      encryptionMode,
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { noOverwrite: true },
  );
  return {
    version: RAW_LEGACY_MIGRATION_VERSION,
    status,
    copied,
    inboxId,
    encryptionMode,
  };
}

/**
 * Resolve every XMTP-owned file from explicit configuration before considering
 * the legacy standalone location. IDACC-managed services must never fall back
 * to the operator's HOME: the app profile is the persistence boundary.
 */
export function resolveXmtpStoragePaths(
  config: XmtpStorageConfig,
  address: string,
  network: 'local' | 'dev' | 'production',
  context: XmtpStorageContext = {},
): XmtpStoragePaths {
  const env = context.env ?? process.env;
  const normalizedAddress = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalizedAddress)) {
    throw new Error('XMTP signer address is unavailable or invalid');
  }

  const workingDirectory = configuredPath(config.workingDirectory);
  const explicitDbPath = configuredPath(config.dbPath);
  const profileRoot = configuredPath(env.IDACC_DATA_DIR);
  const managed = env.IDACC_MANAGED_SERVICE === '1';

  if (managed && profileRoot) {
    assertNoLinkEscape(profileRoot, profileRoot);
    if (workingDirectory && !pathIsWithin(profileRoot, workingDirectory)) {
      throw new Error('XMTP workingDirectory must remain inside the selected IDACC profile');
    }
    if (explicitDbPath && !pathIsWithin(profileRoot, explicitDbPath)) {
      throw new Error('XMTP dbPath must remain inside the selected IDACC profile');
    }
    if (workingDirectory) assertNoLinkEscape(profileRoot, workingDirectory);
    if (explicitDbPath) assertNoLinkEscape(profileRoot, explicitDbPath);
  }
  let storageRoot: string;

  if (workingDirectory) {
    storageRoot = path.join(workingDirectory, '.xmtp');
  } else if (explicitDbPath) {
    storageRoot = path.dirname(explicitDbPath);
  } else if (profileRoot) {
    storageRoot = path.join(profileRoot, 'manager', 'xmtp');
  } else {
    if (managed) {
      throw new Error(
        'XMTP storage is not configured for this IDACC profile; '
        + 'set XmtpConfig.workingDirectory, XmtpConfig.dbPath, or IDACC_DATA_DIR',
      );
    }
    // Deliberate standalone compatibility for existing non-IDACC installations.
    const legacyStandaloneHome = context.homeDirectory
      ?? env.HOME?.trim()
      ?? '/tmp';
    // Canonicalization preserves the exact historical location while avoiding
    // a trusted-root false positive on systems where /tmp itself is a symlink
    // (notably macOS /tmp -> /private/tmp).
    storageRoot = path.join(
      canonicalConfiguredRoot(legacyStandaloneHome) ?? path.resolve(legacyStandaloneHome),
      '.xmtp',
    );
  }

  const dataDir = path.join(storageRoot, normalizedAddress);
  const dataBoundaryRoot = profileRoot
    ?? workingDirectory
    ?? nearestExistingDirectory(storageRoot);
  const dbBoundaryRoot = profileRoot
    ?? (explicitDbPath
      ? nearestExistingDirectory(path.dirname(explicitDbPath))
      : dataBoundaryRoot);
  const dbPath = explicitDbPath ?? path.join(dataDir, `${network}.db3`);
  return {
    dataDir,
    dbPath,
    dbEncryptionKeyPath: path.join(dataDir, 'db.key'),
    allowlistPath: path.join(dataDir, 'allowlist.yaml'),
    dataBoundaryRoot,
    dbBoundaryRoot,
    legacyMigrationMarkerPath: path.join(
      dataDir,
      `.legacy-home-migration-v${LEGACY_MIGRATION_VERSION}-${network}.json`,
    ),
  };
}
