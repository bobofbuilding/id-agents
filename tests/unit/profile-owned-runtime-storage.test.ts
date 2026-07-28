// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  captureCodexAuthReconciliation,
  reconcileCodexAuthAfterRun,
  removeCodexRunHomeNoFollow,
} from '../../src/harness/codex-profile-storage.js';
import {
  CODEX_SHARED_PROVIDER_ENTRIES,
  prepareCodexHome,
  prepareCodexRuntimeEnvironment,
  resolveCodexOverlayRoot,
} from '../../src/harness/codex.js';
import {
  atomicWritePrivateFile,
  copyPrivateFileNoFollow,
  PRIVATE_COPY_BUFFER_BYTES,
  stableProfileOwnerKey,
} from '../../src/lib/profile-storage.js';
import {
  ensureXmtpStoragePrivacy,
  hardenPrivateXmtpFile,
  migrateLegacyRawXmtpStorage,
  migrateLegacyXmtpStorage,
  resolveXmtpStoragePaths,
  writePrivateXmtpFile,
  type XmtpStorageConfig,
} from '../../src/xmtp/storage-paths.js';

const temporaryRoots: string[] = [];

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `id-agents-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function makeDirectoryLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('stable profile owner keys', () => {
  it('survives display-name changes and separates slug-colliding ids', () => {
    const stableId = 'agent_019f-stable';
    expect(stableProfileOwnerKey(stableId, 'before rename', true))
      .toBe(stableProfileOwnerKey(stableId, 'after rename', true));

    const collisionA = stableProfileOwnerKey('agent/a', 'same', true);
    const collisionB = stableProfileOwnerKey('agent?a', 'same', true);
    expect(collisionA.split('-').slice(0, -1).join('-'))
      .toBe(collisionB.split('-').slice(0, -1).join('-'));
    expect(collisionA).not.toBe(collisionB);
    expect(() => stableProfileOwnerKey(undefined, 'display-only', true))
      .toThrow(/ID_AGENT_ID is required/i);
  });
});

describe('profile-owned XMTP storage', () => {
  it('keeps two profiles from sharing keys, allowlists, or databases', () => {
    const root = temporaryRoot('xmtp-profiles');
    const profileA = path.join(root, 'profile-a');
    const profileB = path.join(root, 'profile-b');
    fs.mkdirSync(profileA);
    fs.mkdirSync(profileB);
    const address = '0x1111111111111111111111111111111111111111';
    const allowedA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const allowedB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const ownerKey = stableProfileOwnerKey('agent-stable', 'ignored-name', true);
    const configA: XmtpStorageConfig = {
      workingDirectory: path.join(profileA, 'manager', 'xmtp', 'agents', ownerKey),
      dbPath: path.join(profileA, 'manager', 'xmtp', 'databases', 'agent.db3'),
    };
    const configB: XmtpStorageConfig = {
      workingDirectory: path.join(profileB, 'manager', 'xmtp', 'agents', ownerKey),
      dbPath: path.join(profileB, 'manager', 'xmtp', 'databases', 'agent.db3'),
    };

    const storageA = resolveXmtpStoragePaths(configA, address, 'production', {
      env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profileA },
    });
    const storageB = resolveXmtpStoragePaths(configB, address, 'production', {
      env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profileB },
    });

    expect(storageA.dataDir).toBe(path.join(configA.workingDirectory!, '.xmtp', address));
    expect(storageB.dataDir).toBe(path.join(configB.workingDirectory!, '.xmtp', address));
    expect(storageA.dbPath).toBe(configA.dbPath);
    expect(storageB.dbPath).toBe(configB.dbPath);
    expect(storageA.dbPath.startsWith(`${profileA}${path.sep}`)).toBe(true);
    expect(storageB.dbPath.startsWith(`${profileB}${path.sep}`)).toBe(true);
    expect(storageA.dbPath.startsWith(`${storageA.dataDir}${path.sep}`)).toBe(false);
    expect(storageA.dbEncryptionKeyPath).not.toBe(storageB.dbEncryptionKeyPath);
    expect(storageA.allowlistPath).not.toBe(storageB.allowlistPath);
    expect(storageA.dbPath).not.toBe(storageB.dbPath);

    ensureXmtpStoragePrivacy(storageA);
    ensureXmtpStoragePrivacy(storageB);
    writePrivateXmtpFile(storageA, storageA.dbEncryptionKeyPath, 'key-a');
    writePrivateXmtpFile(storageB, storageB.dbEncryptionKeyPath, 'key-b');
    writePrivateXmtpFile(storageA, storageA.allowlistPath, allowedA);
    writePrivateXmtpFile(storageB, storageB.allowlistPath, allowedB);
    expect(fs.readFileSync(storageA.dbEncryptionKeyPath, 'utf8')).toBe('key-a');
    expect(fs.readFileSync(storageB.dbEncryptionKeyPath, 'utf8')).toBe('key-b');
    expect(fs.readFileSync(storageA.allowlistPath, 'utf8')).toBe(allowedA);
    expect(fs.readFileSync(storageB.allowlistPath, 'utf8')).toBe(allowedB);

    if (process.platform !== 'win32') {
      expect(fs.statSync(storageA.dataDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.dirname(storageA.dbPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(storageA.dbEncryptionKeyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(storageA.allowlistPath).mode & 0o777).toBe(0o600);

      fs.chmodSync(storageB.dbEncryptionKeyPath, 0o666);
      fs.chmodSync(storageB.allowlistPath, 0o666);
      hardenPrivateXmtpFile(storageB, storageB.dbEncryptionKeyPath);
      hardenPrivateXmtpFile(storageB, storageB.allowlistPath);
      expect(fs.statSync(storageB.dbEncryptionKeyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(storageB.allowlistPath).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps address/network storage stable across rename and port changes', () => {
    const root = temporaryRoot('xmtp-retention');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(profile);
    const address = '0x2222222222222222222222222222222222222222';
    const beforeOwner = stableProfileOwnerKey('agent-immutable-id', 'old-name-port-4101', true);
    const afterOwner = stableProfileOwnerKey('agent-immutable-id', 'new-name-port-4999', true);
    const before = resolveXmtpStoragePaths(
      { workingDirectory: path.join(profile, 'manager', 'xmtp', 'agents', beforeOwner) },
      address,
      'production',
      { env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile } },
    );
    const after = resolveXmtpStoragePaths(
      { workingDirectory: path.join(profile, 'manager', 'xmtp', 'agents', afterOwner) },
      address,
      'production',
      { env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile } },
    );

    expect(afterOwner).toBe(beforeOwner);
    expect(after.dataDir).toBe(before.dataDir);
    expect(after.dbPath).toBe(before.dbPath);
    expect(after.dbPath).toBe(path.join(before.dataDir, 'production.db3'));
    expect(after.dbPath).not.toMatch(/4101|4999|old-name|new-name/);
  });

  it('performs one versioned no-follow legacy HOME migration and retains sources', () => {
    const root = temporaryRoot('xmtp-migration');
    const home = path.join(root, 'home');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(home);
    fs.mkdirSync(profile);
    const address = '0x3333333333333333333333333333333333333333';
    const legacy = path.join(home, '.xmtp', address);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'db.key'), 'legacy-key');
    fs.writeFileSync(path.join(legacy, 'allowlist.yaml'), 'legacy-allowlist');
    fs.writeFileSync(path.join(legacy, 'production.db3'), 'legacy-db');
    fs.writeFileSync(path.join(legacy, 'production.db3-wal'), 'legacy-wal');
    fs.writeFileSync(path.join(legacy, 'production.db3-shm'), 'legacy-shm');
    fs.writeFileSync(path.join(legacy, 'production.db3-journal'), 'legacy-journal');
    fs.writeFileSync(path.join(legacy, 'production.db3.sqlcipher_salt'), 'legacy-salt');
    fs.writeFileSync(path.join(legacy, 'unrelated.secret'), 'must-not-copy');

    const owner = stableProfileOwnerKey('agent-upgrade-id', 'renamed-agent', true);
    const storage = resolveXmtpStoragePaths(
      { workingDirectory: path.join(profile, 'manager', 'xmtp', 'agents', owner) },
      address,
      'production',
      {
        env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile },
        homeDirectory: home,
      },
    );
    const first = migrateLegacyXmtpStorage(storage, address, 'production', {
      env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile },
      homeDirectory: home,
    });

    expect(first.status).toBe('migrated');
    expect(first.version).toBe(1);
    expect(first.copied).toEqual([
      'db.key',
      'allowlist.yaml',
      'production.db3',
      'production.db3-wal',
      'production.db3-shm',
      'production.db3-journal',
      'production.db3.sqlcipher_salt',
    ]);
    expect(fs.readFileSync(storage.dbEncryptionKeyPath, 'utf8')).toBe('legacy-key');
    expect(fs.readFileSync(storage.allowlistPath, 'utf8')).toBe('legacy-allowlist');
    expect(fs.readFileSync(storage.dbPath, 'utf8')).toBe('legacy-db');
    expect(fs.readFileSync(`${storage.dbPath}-wal`, 'utf8')).toBe('legacy-wal');
    expect(fs.readFileSync(`${storage.dbPath}-shm`, 'utf8')).toBe('legacy-shm');
    expect(fs.readFileSync(`${storage.dbPath}-journal`, 'utf8')).toBe('legacy-journal');
    expect(fs.readFileSync(`${storage.dbPath}.sqlcipher_salt`, 'utf8')).toBe('legacy-salt');
    expect(fs.existsSync(path.join(storage.dataDir, 'unrelated.secret'))).toBe(false);
    expect(fs.existsSync(path.join(legacy, 'db.key'))).toBe(true);
    expect(fs.existsSync(storage.legacyMigrationMarkerPath)).toBe(true);

    fs.writeFileSync(path.join(legacy, 'db.key'), 'changed-after-migration');
    const second = migrateLegacyXmtpStorage(storage, address, 'production', {
      env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile },
      homeDirectory: home,
    });
    expect(second.status).toBe('already-complete');
    expect(fs.readFileSync(storage.dbEncryptionKeyPath, 'utf8')).toBe('legacy-key');
  });

  it('copies multi-megabyte legacy files through one bounded fixed-size buffer', () => {
    const root = temporaryRoot('xmtp-bounded-copy');
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(destinationRoot);
    const source = path.join(sourceRoot, 'production.db3');
    const destination = path.join(destinationRoot, 'production.db3');
    const size = (PRIVATE_COPY_BUFFER_BYTES * 40) + 123;
    const payload = Buffer.alloc(size, 0x5a);
    payload[payload.length - 1] = 0x33;
    fs.writeFileSync(source, payload);
    const chunks: Array<{ bytes: number; capacity: number }> = [];

    expect(copyPrivateFileNoFollow(
      sourceRoot,
      source,
      destinationRoot,
      destination,
      {
        onChunk: (bytes, capacity) => chunks.push({ bytes, capacity }),
      },
    )).toBe(true);

    expect(chunks.length).toBeGreaterThan(40);
    expect(chunks.every(({ bytes, capacity }) => (
      capacity === PRIVATE_COPY_BUFFER_BYTES
      && bytes > 0
      && bytes <= PRIVATE_COPY_BUFFER_BYTES
    ))).toBe(true);
    expect(chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)).toBe(size);
    expect(fs.readFileSync(destination)).toEqual(payload);
    expect(fs.readFileSync(source)).toEqual(payload);
    expect(fs.readdirSync(destinationRoot).filter((name) => name.endsWith('.copy'))).toEqual([]);

    fs.writeFileSync(destination, 'retained-destination');
    expect(copyPrivateFileNoFollow(
      sourceRoot,
      source,
      destinationRoot,
      destination,
    )).toBe(false);
    expect(fs.readFileSync(destination, 'utf8')).toBe('retained-destination');
  });

  it('tracks legacy migration independently for dev and production networks', () => {
    const root = temporaryRoot('xmtp-multi-network');
    const home = path.join(root, 'home');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(home);
    fs.mkdirSync(profile);
    const address = '0x7777777777777777777777777777777777777777';
    const legacy = path.join(home, '.xmtp', address);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'db.key'), 'shared-key');
    fs.writeFileSync(path.join(legacy, 'allowlist.yaml'), 'shared-allowlist');
    fs.writeFileSync(path.join(legacy, 'dev.db3'), 'dev-db');
    fs.writeFileSync(path.join(legacy, 'dev.db3.sqlcipher_salt'), 'dev-salt');
    fs.writeFileSync(path.join(legacy, 'production.db3'), 'production-db');
    fs.writeFileSync(path.join(legacy, 'production.db3.sqlcipher_salt'), 'production-salt');
    const workingDirectory = path.join(
      profile,
      'manager',
      'xmtp',
      'agents',
      stableProfileOwnerKey('multi-network-agent', 'ignored', true),
    );
    const context = {
      env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile },
      homeDirectory: home,
    };
    const dev = resolveXmtpStoragePaths({ workingDirectory }, address, 'dev', context);
    const production = resolveXmtpStoragePaths(
      { workingDirectory },
      address,
      'production',
      context,
    );

    expect(dev.legacyMigrationMarkerPath).not.toBe(production.legacyMigrationMarkerPath);
    expect(migrateLegacyXmtpStorage(dev, address, 'dev', context).status).toBe('migrated');
    expect(fs.readFileSync(dev.dbPath, 'utf8')).toBe('dev-db');
    expect(fs.readFileSync(`${dev.dbPath}.sqlcipher_salt`, 'utf8')).toBe('dev-salt');
    expect(fs.existsSync(production.dbPath)).toBe(false);

    const productionResult = migrateLegacyXmtpStorage(
      production,
      address,
      'production',
      context,
    );
    expect(productionResult.status).toBe('migrated');
    expect(productionResult.copied).toEqual([
      'production.db3',
      'production.db3.sqlcipher_salt',
    ]);
    expect(fs.readFileSync(production.dbPath, 'utf8')).toBe('production-db');
    expect(fs.readFileSync(`${production.dbPath}.sqlcipher_salt`, 'utf8'))
      .toBe('production-salt');
    expect(fs.existsSync(dev.legacyMigrationMarkerPath)).toBe(true);
    expect(fs.existsSync(production.legacyMigrationMarkerPath)).toBe(true);
  });

  it('probes the exact historical HOME location as well as the current OS home', () => {
    const root = temporaryRoot('xmtp-historical-home');
    const historicalHome = path.join(root, 'historical-home');
    const currentHome = path.join(root, 'current-home');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(historicalHome);
    fs.mkdirSync(currentHome);
    fs.mkdirSync(profile);
    const address = '0x8888888888888888888888888888888888888888';
    const legacy = path.join(historicalHome, '.xmtp', address);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'db.key'), 'historical-key');
    fs.writeFileSync(path.join(legacy, 'allowlist.yaml'), 'historical-allowlist');
    fs.writeFileSync(path.join(legacy, 'production.db3'), 'historical-db');
    fs.writeFileSync(path.join(legacy, 'production.db3.sqlcipher_salt'), 'historical-salt');
    const storage = resolveXmtpStoragePaths(
      { workingDirectory: path.join(profile, 'manager', 'xmtp', 'agents', 'historical') },
      address,
      'production',
      {
        env: {
          IDACC_MANAGED_SERVICE: '1',
          IDACC_DATA_DIR: profile,
          HOME: historicalHome,
        },
        homeDirectory: currentHome,
      },
    );

    expect(migrateLegacyXmtpStorage(storage, address, 'production', {
      env: {
        IDACC_MANAGED_SERVICE: '1',
        IDACC_DATA_DIR: profile,
        HOME: historicalHome,
      },
      homeDirectory: currentHome,
    }).status).toBe('migrated');
    expect(fs.readFileSync(storage.dbPath, 'utf8')).toBe('historical-db');
    expect(fs.readFileSync(storage.allowlistPath, 'utf8')).toBe('historical-allowlist');
  });

  it('migrates the sole old port-keyed OWS database across a port change', () => {
    const root = temporaryRoot('xmtp-legacy-ows-port');
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    fs.mkdirSync(profile);
    const address = '0x9999999999999999999999999999999999999999';
    const legacyHome = path.join(home, '.xmtp', address);
    const legacyDatabaseDirectory = path.join(workspace, '.xmtp');
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.mkdirSync(legacyDatabaseDirectory);
    fs.writeFileSync(path.join(legacyHome, 'db.key'), 'ows-key');
    fs.writeFileSync(path.join(legacyHome, 'allowlist.yaml'), 'ows-allowlist');
    const oldDatabase = path.join(legacyDatabaseDirectory, 'production-4101.db3');
    fs.writeFileSync(oldDatabase, 'ows-database');
    fs.writeFileSync(`${oldDatabase}-wal`, 'ows-wal');
    fs.writeFileSync(`${oldDatabase}.sqlcipher_salt`, 'ows-salt');
    const storage = resolveXmtpStoragePaths(
      { workingDirectory: path.join(profile, 'manager', 'xmtp', 'agents', 'ows') },
      address,
      'production',
      { env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile, HOME: home } },
    );

    const result = migrateLegacyXmtpStorage(storage, address, 'production', {
      env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile, HOME: home },
      homeDirectory: home,
      legacyWorkingDirectory: workspace,
      legacyPort: 4999,
    });
    expect(result.status).toBe('migrated');
    expect(fs.readFileSync(storage.dbEncryptionKeyPath, 'utf8')).toBe('ows-key');
    expect(fs.readFileSync(storage.dbPath, 'utf8')).toBe('ows-database');
    expect(fs.readFileSync(`${storage.dbPath}-wal`, 'utf8')).toBe('ows-wal');
    expect(fs.readFileSync(`${storage.dbPath}.sqlcipher_salt`, 'utf8')).toBe('ows-salt');
    expect(fs.existsSync(oldDatabase)).toBe(true);
  });

  it('rejects conflicting or incomplete encrypted legacy database bundles', () => {
    for (const scenario of ['conflict', 'missing-salt'] as const) {
      const root = temporaryRoot(`xmtp-legacy-${scenario}`);
      const home = path.join(root, 'home');
      const profile = path.join(root, 'profile');
      fs.mkdirSync(home);
      fs.mkdirSync(profile);
      const address = scenario === 'conflict'
        ? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        : '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const legacy = path.join(home, '.xmtp', address);
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, 'db.key'), 'legacy-key');
      fs.writeFileSync(path.join(legacy, 'production.db3'), 'legacy-db');
      if (scenario === 'conflict') {
        fs.writeFileSync(path.join(legacy, 'production.db3.sqlcipher_salt'), 'legacy-salt');
      }
      const storage = resolveXmtpStoragePaths(
        { workingDirectory: path.join(profile, 'manager', 'xmtp', 'agents', scenario) },
        address,
        'production',
        { env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile, HOME: home } },
      );
      ensureXmtpStoragePrivacy(storage);
      if (scenario === 'conflict') {
        writePrivateXmtpFile(storage, storage.dbEncryptionKeyPath, 'new-profile-key');
      }

      expect(() => migrateLegacyXmtpStorage(storage, address, 'production', {
        env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile, HOME: home },
        homeDirectory: home,
      })).toThrow(scenario === 'conflict' ? /conflict/i : /incomplete/i);
      expect(fs.existsSync(storage.dbPath)).toBe(false);
      expect(fs.existsSync(storage.legacyMigrationMarkerPath)).toBe(false);
    }
  });

  it('migrates the exact unencrypted raw SDK cwd database without inventing a key', () => {
    const root = temporaryRoot('xmtp-raw-cwd');
    const legacyCwd = path.join(root, 'legacy-cwd');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(legacyCwd);
    fs.mkdirSync(profile);
    const address = '0xcccccccccccccccccccccccccccccccccccccccc';
    const inboxId = 'raw-inbox-cwd';
    const source = path.join(legacyCwd, `xmtp-dev-${inboxId}.db3`);
    fs.writeFileSync(source, 'raw-plain-db');
    fs.writeFileSync(`${source}-wal`, 'raw-plain-wal');
    const storage = resolveXmtpStoragePaths(
      { workingDirectory: path.join(profile, 'manager', 'xmtp', 'agents', 'raw-cwd') },
      address,
      'dev',
      { env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile } },
    );

    const result = migrateLegacyRawXmtpStorage(storage, inboxId, 'dev', {
      env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile },
      legacyWorkingDirectory: legacyCwd,
    });
    expect(result.status).toBe('migrated');
    expect(result.encryptionMode).toBe('unencrypted');
    expect(fs.readFileSync(storage.dbPath, 'utf8')).toBe('raw-plain-db');
    expect(fs.readFileSync(`${storage.dbPath}-wal`, 'utf8')).toBe('raw-plain-wal');
    expect(fs.existsSync(storage.dbEncryptionKeyPath)).toBe(false);
    expect(fs.existsSync(source)).toBe(true);
    expect(migrateLegacyRawXmtpStorage(storage, inboxId, 'dev', {
      env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile },
      legacyWorkingDirectory: legacyCwd,
    }).status).toBe('already-complete');
  });

  it('migrates only the exact encrypted raw SDK DB-directory inbox family', () => {
    const root = temporaryRoot('xmtp-raw-db-directory');
    const legacyDirectory = path.join(root, 'legacy-db-directory');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(legacyDirectory);
    fs.mkdirSync(profile);
    const address = '0xdddddddddddddddddddddddddddddddddddddddd';
    const inboxId = 'raw-inbox-encrypted';
    const source = path.join(legacyDirectory, `xmtp-${inboxId}.db3`);
    fs.writeFileSync(source, 'raw-encrypted-db');
    fs.writeFileSync(`${source}.sqlcipher_salt`, 'raw-encrypted-salt');
    fs.writeFileSync(path.join(legacyDirectory, 'xmtp-another-inbox.db3'), 'decoy');
    const key = 'ab'.repeat(32);
    const storage = resolveXmtpStoragePaths(
      { workingDirectory: path.join(profile, 'manager', 'xmtp', 'agents', 'raw-dir') },
      address,
      'production',
      { env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile } },
    );

    const result = migrateLegacyRawXmtpStorage(storage, inboxId, 'production', {
      env: {
        IDACC_MANAGED_SERVICE: '1',
        IDACC_DATA_DIR: profile,
        XMTP_DB_DIRECTORY: legacyDirectory,
      },
      dbEncryptionKey: `0x${key}`,
    });
    expect(result.encryptionMode).toBe('profile-key');
    expect(fs.readFileSync(storage.dbEncryptionKeyPath, 'utf8')).toBe(key);
    expect(fs.readFileSync(storage.dbPath, 'utf8')).toBe('raw-encrypted-db');
    expect(fs.readFileSync(`${storage.dbPath}.sqlcipher_salt`, 'utf8'))
      .toBe('raw-encrypted-salt');
    expect(fs.existsSync(path.join(storage.dataDir, 'xmtp-another-inbox.db3'))).toBe(false);
    expect(fs.existsSync(source)).toBe(true);
  });

  it('does not import an encrypted raw database without its explicit key', () => {
    const root = temporaryRoot('xmtp-raw-missing-key');
    const legacyCwd = path.join(root, 'legacy-cwd');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(legacyCwd);
    fs.mkdirSync(profile);
    const address = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const inboxId = 'raw-inbox-missing-key';
    const source = path.join(legacyCwd, `xmtp-production-${inboxId}.db3`);
    fs.writeFileSync(source, 'encrypted-db');
    fs.writeFileSync(`${source}.sqlcipher_salt`, 'salt');
    const storage = resolveXmtpStoragePaths(
      { workingDirectory: path.join(profile, 'manager', 'xmtp', 'agents', 'raw-missing') },
      address,
      'production',
      { env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile } },
    );

    expect(() => migrateLegacyRawXmtpStorage(storage, inboxId, 'production', {
      env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile },
      legacyWorkingDirectory: legacyCwd,
    })).toThrow(/requires its explicit encryption key/i);
    expect(fs.existsSync(storage.dbPath)).toBe(false);
  });

  it('fails closed when legacy or destination paths contain links', () => {
    const root = temporaryRoot('xmtp-links');
    const home = path.join(root, 'home');
    const profile = path.join(root, 'profile');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(home);
    fs.mkdirSync(profile);
    fs.mkdirSync(outside);
    const address = '0x4444444444444444444444444444444444444444';
    const legacyParent = path.join(home, '.xmtp');
    fs.mkdirSync(legacyParent);
    makeDirectoryLink(outside, path.join(legacyParent, address));

    const storage = resolveXmtpStoragePaths(
      { workingDirectory: path.join(profile, 'manager', 'xmtp', 'agents', 'stable') },
      address,
      'production',
      {
        env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile },
        homeDirectory: home,
      },
    );
    expect(() => migrateLegacyXmtpStorage(storage, address, 'production', {
      env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile },
      homeDirectory: home,
    })).toThrow(/legacy XMTP directory is unsafe/i);

    const escapedProfile = path.join(root, 'escaped-profile');
    fs.mkdirSync(escapedProfile);
    makeDirectoryLink(outside, path.join(escapedProfile, 'manager'));
    expect(() => resolveXmtpStoragePaths(
      { workingDirectory: path.join(escapedProfile, 'manager', 'xmtp') },
      address,
      'production',
      { env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: escapedProfile } },
    )).toThrow(/symlink|junction/i);
  });

  it('does not write an allowlist outside the profile after its parent is replaced by a link', () => {
    const root = temporaryRoot('xmtp-allowlist-parent-swap');
    const profile = path.join(root, 'profile');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(profile);
    fs.mkdirSync(outside);
    const address = '0x7777777777777777777777777777777777777777';
    const owner = stableProfileOwnerKey('agent-parent-swap', 'agent', true);
    const storage = resolveXmtpStoragePaths(
      { workingDirectory: path.join(profile, 'manager', 'xmtp', 'agents', owner) },
      address,
      'production',
      { env: { IDACC_MANAGED_SERVICE: '1', IDACC_DATA_DIR: profile } },
    );
    ensureXmtpStoragePrivacy(storage);

    // prepareStorage() has completed, then a local attacker replaces the
    // already-resolved allowlist parent before saveAllowlist() reaches its
    // sole write primitive.
    fs.rmSync(storage.dataDir, { recursive: true });
    makeDirectoryLink(outside, storage.dataDir);

    expect(() => writePrivateXmtpFile(
      storage,
      storage.allowlistPath,
      '# XMTP allowed senders\n- address: 0xaaaa\n',
    )).toThrow(/symlink|junction/i);
    expect(fs.existsSync(path.join(outside, 'allowlist.yaml'))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('refuses atomic private writes through final symlinks', () => {
    const root = temporaryRoot('xmtp-final-link');
    const privateRoot = path.join(root, 'private');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(privateRoot);
    fs.writeFileSync(outside, 'outside');
    const link = path.join(privateRoot, 'secret');
    fs.symlinkSync(outside, link);

    expect(() => atomicWritePrivateFile(privateRoot, link, 'replacement'))
      .toThrow(/symlink|no-follow/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
  });

  it('uses the profile root and never falls back to HOME in managed mode', () => {
    const root = temporaryRoot('xmtp-profile-root');
    const profile = path.join(root, 'profile');
    const fakeHome = path.join(root, 'home');
    fs.mkdirSync(profile);
    fs.mkdirSync(fakeHome);
    const address = '0x5555555555555555555555555555555555555555';
    const storage = resolveXmtpStoragePaths({}, address, 'dev', {
      env: {
        IDACC_MANAGED_SERVICE: '1',
        IDACC_DATA_DIR: profile,
        HOME: fakeHome,
      },
      homeDirectory: fakeHome,
    });
    expect(storage.dataDir).toBe(path.join(profile, 'manager', 'xmtp', address));
    expect(storage.dbPath).toBe(path.join(storage.dataDir, 'dev.db3'));
    expect(storage.dataDir).not.toContain(fakeHome);

    expect(() => resolveXmtpStoragePaths(
      {},
      address,
      'production',
      {
        env: { IDACC_MANAGED_SERVICE: '1', HOME: fakeHome },
        homeDirectory: fakeHome,
      },
    )).toThrow(/storage is not configured for this IDACC profile/i);
    expect(fs.existsSync(path.join(fakeHome, '.xmtp'))).toBe(false);
  });

  it('preserves the legacy HOME location for standalone use', () => {
    const root = temporaryRoot('xmtp-standalone');
    const address = '0x6666666666666666666666666666666666666666';
    const storage = resolveXmtpStoragePaths({}, address, 'local', {
      env: { HOME: root },
    });
    expect(storage.dataDir).toBe(path.join(fs.realpathSync(root), '.xmtp', address));
    expect(storage.dbPath).toBe(path.join(storage.dataDir, 'local.db3'));

    const withoutHome = resolveXmtpStoragePaths({}, address, 'local', {
      env: {},
    });
    expect(withoutHome.dataDir).toBe(path.join(
      fs.existsSync('/tmp') ? fs.realpathSync('/tmp') : path.resolve('/tmp'),
      '.xmtp',
      address,
    ));
  });
});

describe('profile-owned Codex MCP overlays', () => {
  function providerFixture(root: string): string {
    const providerHome = path.join(root, 'home', '.codex');
    fs.mkdirSync(path.join(providerHome, 'sessions', '2026'), { recursive: true });
    fs.writeFileSync(path.join(providerHome, 'sessions', '2026', 'operator-thread.jsonl'), 'operator-session');
    fs.writeFileSync(path.join(providerHome, 'auth.json'), '{"provider":"shared"}\n');
    fs.writeFileSync(path.join(providerHome, 'goals_1.sqlite'), 'must-not-be-shared');
    fs.writeFileSync(
      path.join(providerHome, 'config.toml'),
      'model = "personal-model"\n[mcp_servers.profile]\ncommand = "provider-secret-command"\n',
    );
    return providerHome;
  }

  function managedContext(
    profile: string,
    providerHome: string,
    agentId: string,
    runId: string,
    providerSharing: 'auto' | 'copy' = 'auto',
  ) {
    return {
      env: {
        IDACC_MANAGED_SERVICE: '1',
        IDACC_DATA_DIR: profile,
        ID_AGENT_ID: agentId,
        CODEX_HOME: providerHome,
      },
      providerSharing,
      runId,
    } as const;
  }

  function writeLegacyCodexSession(
    providerHome: string,
    sessionId: string,
    workingDirectory: string,
    body = '{"type":"response_item","payload":{"type":"message"}}\n',
  ): string {
    const directory = path.join(providerHome, 'sessions', '2026', '07', '27');
    fs.mkdirSync(directory, { recursive: true });
    const sessionPath = path.join(
      directory,
      `rollout-2026-07-27T10-00-00-${sessionId}.jsonl`,
    );
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        timestamp: '2026-07-27T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: sessionId,
          cwd: workingDirectory,
        },
      })}\n${body}`,
    );
    return sessionPath;
  }

  it('uses immutable run configs with stable, profile-local per-agent sessions', () => {
    const root = temporaryRoot('codex-profiles');
    const providerHome = providerFixture(root);
    const profileA = path.join(root, 'profile-a');
    const profileB = path.join(root, 'profile-b');
    fs.mkdirSync(profileA);
    fs.mkdirSync(profileB);
    const agentId = 'agent-codex-stable';
    const ownerKey = stableProfileOwnerKey(agentId, 'ignored', true);

    const homeA = prepareCodexHome(
      [{ name: 'profile', command: 'server-a', env: { PROFILE_TOKEN: 'secret-a' } }],
      'before-rename',
      managedContext(profileA, providerHome, agentId, 'profile-a-first'),
    )!;
    const renamedHomeA = prepareCodexHome(
      [{ name: 'profile', command: 'server-a', env: { PROFILE_TOKEN: 'secret-a' } }],
      'after-rename',
      managedContext(profileA, providerHome, agentId, 'profile-a-second'),
    )!;
    const homeB = prepareCodexHome(
      [{ name: 'profile', command: 'server-b', env: { PROFILE_TOKEN: 'secret-b' } }],
      'same-display',
      managedContext(profileB, providerHome, agentId, 'profile-b-first'),
    )!;

    const ownerA = path.join(profileA, 'manager', 'codex-overlays', ownerKey);
    const ownerB = path.join(profileB, 'manager', 'codex-overlays', ownerKey);
    expect(homeA).toContain(path.join(ownerA, 'runs'));
    expect(renamedHomeA).toContain(path.join(ownerA, 'runs'));
    expect(homeB).toContain(path.join(ownerB, 'runs'));
    expect(renamedHomeA).not.toBe(homeA);
    expect(homeA).not.toBe(homeB);
    const configA = fs.readFileSync(path.join(homeA, 'config.toml'), 'utf8');
    const configB = fs.readFileSync(path.join(homeB, 'config.toml'), 'utf8');
    expect(configA).toContain('secret-a');
    expect(configA).not.toContain('secret-b');
    expect(configA).not.toContain('provider-secret-command');
    expect(configA).not.toContain('personal-model');
    expect(configB).toContain('secret-b');
    expect(configB).not.toContain('secret-a');
    expect(CODEX_SHARED_PROVIDER_ENTRIES).toEqual(['auth.json']);
    expect(fs.existsSync(path.join(homeA, 'goals_1.sqlite'))).toBe(false);
    expect(fs.existsSync(path.join(homeB, 'goals_1.sqlite'))).toBe(false);
    expect(fs.existsSync(path.join(homeA, 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(homeA, 'sessions', '2026', 'operator-thread.jsonl'))).toBe(false);

    fs.writeFileSync(path.join(homeA, 'sessions', 'agent-a-thread.jsonl'), 'agent-a-session');
    expect(fs.readFileSync(path.join(renamedHomeA, 'sessions', 'agent-a-thread.jsonl'), 'utf8'))
      .toBe('agent-a-session');
    expect(fs.existsSync(path.join(homeB, 'sessions', 'agent-a-thread.jsonl'))).toBe(false);

    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(homeA, 'config.toml')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(homeA).mode & 0o777).toBe(0o700);
    }
  });

  it('imports only an exact legacy session authorized for this stable agent', () => {
    const root = temporaryRoot('codex-legacy-session');
    const providerHome = providerFixture(root);
    const profile = path.join(root, 'profile');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(profile);
    fs.mkdirSync(workspace);
    const ownedSessionId = '019f4ef6-1adb-7cf1-a171-64dd1be00786';
    const unrelatedSessionId = '019f4ef6-1adb-7cf1-a171-64dd1be00787';
    const ownedSource = writeLegacyCodexSession(
      providerHome,
      ownedSessionId,
      workspace,
    );
    writeLegacyCodexSession(
      providerHome,
      unrelatedSessionId,
      workspace,
    );
    const baseEnv = {
      IDACC_MANAGED_SERVICE: '1',
      IDACC_DATA_DIR: profile,
      ID_AGENT_ID: 'legacy-session-agent',
      ID_AGENT_NAME: 'Legacy Session Agent',
      CODEX_HOME: providerHome,
    };

    const unverified = prepareCodexRuntimeEnvironment(
      {
        workingDirectory: workspace,
        resume: ownedSessionId,
      },
      workspace,
      baseEnv,
    );
    expect(fs.existsSync(path.join(
      unverified.codexHome!,
      'sessions',
      '2026',
      '07',
      '27',
      path.basename(ownedSource),
    ))).toBe(false);

    const verified = prepareCodexRuntimeEnvironment(
      {
        workingDirectory: workspace,
        resume: ownedSessionId,
        resumeAuthorization: 'agent-owned',
      },
      workspace,
      baseEnv,
    );
    const migrated = path.join(
      verified.codexHome!,
      'sessions',
      '2026',
      '07',
      '27',
      path.basename(ownedSource),
    );
    expect(fs.readFileSync(migrated, 'utf8')).toBe(
      fs.readFileSync(ownedSource, 'utf8'),
    );
    expect(fs.existsSync(path.join(
      verified.codexHome!,
      'sessions',
      '2026',
      '07',
      '27',
      `rollout-2026-07-27T10-00-00-${unrelatedSessionId}.jsonl`,
    ))).toBe(false);

    const renamed = prepareCodexHome(
      [],
      'renamed-display',
      {
        ...managedContext(
          profile,
          providerHome,
          'legacy-session-agent',
          'legacy-session-second',
          'copy',
        ),
        workingDirectory: workspace,
        resumeId: ownedSessionId,
        resumeAuthorization: 'agent-owned',
      },
    )!;
    expect(fs.readFileSync(path.join(
      renamed,
      'sessions',
      '2026',
      '07',
      '27',
      path.basename(ownedSource),
    ), 'utf8')).toBe(fs.readFileSync(ownedSource, 'utf8'));
  });

  it('keeps exact-agent legacy continuity across workspace moves and rejects cross-agent adoption', () => {
    const root = temporaryRoot('codex-legacy-session-owner');
    const providerHome = providerFixture(root);
    const profile = path.join(root, 'profile');
    const workspace = path.join(root, 'moved-workspace');
    const oldWorkspace = path.join(root, 'old-workspace');
    fs.mkdirSync(profile);
    fs.mkdirSync(workspace);
    fs.mkdirSync(oldWorkspace);
    const sessionId = '019f4ef6-1adb-7cf1-a171-64dd1be00788';
    const source = writeLegacyCodexSession(
      providerHome,
      sessionId,
      oldWorkspace,
    );
    const context = {
      ...managedContext(
        profile,
        providerHome,
        'legacy-session-agent',
        'moved-owner',
        'copy',
      ),
      workingDirectory: workspace,
      resumeId: sessionId,
      resumeAuthorization: 'agent-owned' as const,
    };

    expect(() => prepareCodexHome([], 'legacy-session-agent', context)).not.toThrow();
    const stableCopy = path.join(
      profile,
      'manager',
      'codex-overlays',
      stableProfileOwnerKey('legacy-session-agent', 'ignored', true),
      'state',
      'sessions',
      '2026',
      '07',
      '27',
      path.basename(source),
    );
    expect(fs.readFileSync(stableCopy, 'utf8')).toBe(fs.readFileSync(source, 'utf8'));

    expect(() => prepareCodexHome(
      [],
      'other-agent',
      {
        ...managedContext(
          profile,
          providerHome,
          'other-legacy-session-agent',
          'cross-agent-adoption',
          'copy',
        ),
        workingDirectory: oldWorkspace,
        resumeId: sessionId,
        resumeAuthorization: 'agent-owned',
      },
    )).toThrow(/already claimed by another agent/i);
  });

  it('rejects legacy files whose embedded session id does not match the authorized id', () => {
    const root = temporaryRoot('codex-legacy-session-metadata');
    const providerHome = providerFixture(root);
    const profile = path.join(root, 'profile');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(profile);
    fs.mkdirSync(workspace);
    const sessionId = '019f4ef6-1adb-7cf1-a171-64dd1be00798';
    const source = writeLegacyCodexSession(providerHome, sessionId, workspace);
    const original = fs.readFileSync(source, 'utf8');
    fs.writeFileSync(source, original.replace(sessionId, '019f4ef6-1adb-7cf1-a171-64dd1be00799'));

    expect(() => prepareCodexHome(
      [],
      'legacy-session-agent',
      {
        ...managedContext(
          profile,
          providerHome,
          'legacy-session-agent',
          'mismatched-session-id',
          'copy',
        ),
        workingDirectory: workspace,
        resumeId: sessionId,
        resumeAuthorization: 'agent-owned',
      },
    )).toThrow(/invalid or mismatched session metadata/i);
  });

  it.skipIf(process.platform === 'win32')(
    'fails closed when a legacy source is replaced during its bounded copy',
    () => {
      const root = temporaryRoot('codex-legacy-session-race');
      const providerHome = providerFixture(root);
      const profile = path.join(root, 'profile');
      const workspace = path.join(root, 'workspace');
      fs.mkdirSync(profile);
      fs.mkdirSync(workspace);
      const sessionId = '019f4ef6-1adb-7cf1-a171-64dd1be00789';
      const source = writeLegacyCodexSession(
        providerHome,
        sessionId,
        workspace,
        `${'x'.repeat(2 * PRIVATE_COPY_BUFFER_BYTES)}\n`,
      );
      const moved = `${source}.replaced`;
      let replaced = false;

      expect(() => prepareCodexHome(
        [],
        'legacy-session-agent',
        {
          ...managedContext(
            profile,
            providerHome,
            'legacy-session-agent',
            'source-race',
            'copy',
          ),
          workingDirectory: workspace,
          resumeId: sessionId,
          resumeAuthorization: 'agent-owned',
          providerCopyObserver: () => {
            if (replaced) return;
            replaced = true;
            fs.renameSync(source, moved);
            fs.writeFileSync(
              source,
              '{"type":"session_meta","payload":{"id":"attacker","cwd":"/"}}\n',
            );
          },
        },
      )).toThrow(/changed during no-follow open/i);

      const stableCopy = path.join(
        profile,
        'manager',
        'codex-overlays',
        stableProfileOwnerKey('legacy-session-agent', 'ignored', true),
        'state',
        'sessions',
        '2026',
        '07',
        '27',
        path.basename(source),
      );
      expect(fs.existsSync(stableCopy)).toBe(false);
    },
  );

  it('uses distinct exact configs for concurrent normal and control-plane runs', () => {
    const root = temporaryRoot('codex-managed-zero-modules');
    const providerHome = providerFixture(root);
    const profile = path.join(root, 'profile');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(profile);
    fs.mkdirSync(workspace);
    const baseEnv = {
      IDACC_MANAGED_SERVICE: '1',
      IDACC_DATA_DIR: profile,
      ID_AGENT_ID: 'zero-module-agent',
      ID_AGENT_NAME: 'No Modules',
      CODEX_HOME: providerHome,
    };
    const normal = prepareCodexRuntimeEnvironment(
      {
        workingDirectory: workspace,
        mcpServers: [{
          name: 'profile',
          command: 'dispatch-command',
          env: { DISPATCH_SECRET: 'normal-run-only' },
        }],
      },
      workspace,
      baseEnv,
    );
    const control = prepareCodexRuntimeEnvironment(
      {
        workingDirectory: workspace,
        executionPolicy: 'control-plane-readonly',
        mcpServers: [],
      },
      workspace,
      baseEnv,
    );

    expect(normal.codexHome).toBeTruthy();
    expect(control.codexHome).toBeTruthy();
    expect(normal.codexHome).not.toBe(control.codexHome);
    expect(normal.env.CODEX_HOME).toBe(normal.codexHome);
    expect(control.env.CODEX_HOME).toBe(control.codexHome);
    expect(normal.env.CODEX_HOME).not.toBe(providerHome);
    expect(normal.env.CODEX_HOME).toContain(
      path.join(profile, 'manager', 'codex-overlays'),
    );
    const normalConfig = fs.readFileSync(path.join(normal.codexHome!, 'config.toml'), 'utf8');
    const controlConfig = fs.readFileSync(path.join(control.codexHome!, 'config.toml'), 'utf8');
    expect(normalConfig.match(/\[mcp_servers\.profile\]/g)).toHaveLength(1);
    expect(normalConfig).toContain('normal-run-only');
    expect(normalConfig).not.toContain('provider-secret-command');
    expect(controlConfig).toBe('');
    expect(controlConfig).not.toContain('normal-run-only');
    expect(fs.existsSync(path.join(control.codexHome!, 'goals_1.sqlite'))).toBe(false);
  });

  it('renders remote headers privately, escapes TOML injection, and rejects legacy SSE', () => {
    const root = temporaryRoot('codex-remote-mcp');
    const providerHome = providerFixture(root);
    const profile = path.join(root, 'profile');
    fs.mkdirSync(profile);
    const home = prepareCodexHome(
      [{
        name: 'remote"]\n[mcp_servers.injected',
        transport: 'http',
        url: 'https://mcp.example.test/path\nnot-a-new-key',
        headers: {
          Authorization: 'Bearer private-header-token',
          'X-Injected\n[mcp_servers.hijack]': 'line-one\r\nline-two',
        },
      }],
      'remote-agent',
      managedContext(profile, providerHome, 'remote-agent', 'remote-http'),
    )!;
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    expect(config).toContain('.http_headers]');
    expect(config).toContain('Bearer private-header-token');
    expect(config).toContain('\\n[mcp_servers.injected');
    expect(config).toContain('line-one\\r\\nline-two');
    expect(config).not.toContain('\n[mcp_servers.injected]');
    expect(config).not.toContain('\n[mcp_servers.hijack]');

    expect(() => prepareCodexHome(
      [{
        name: 'legacy',
        transport: 'sse',
        url: 'https://mcp.example.test/events',
      }],
      'remote-agent',
      managedContext(profile, providerHome, 'remote-agent', 'legacy-sse'),
    )).toThrow(/legacy SSE transport.*not supported/i);
  });

  it('uses bounded auth copies without importing large provider session trees', () => {
    const root = temporaryRoot('codex-copy-fallback');
    const providerHome = providerFixture(root);
    const profile = path.join(root, 'profile');
    fs.mkdirSync(profile);
    fs.writeFileSync(
      path.join(providerHome, 'auth.json'),
      `{"token":"${'a'.repeat((2 * PRIVATE_COPY_BUFFER_BYTES) + 17)}"}\n`,
    );
    const largeSession = path.join(providerHome, 'sessions', '2026', 'large.jsonl');
    fs.writeFileSync(largeSession, Buffer.alloc((2 * 1024 * 1024) + 17, 0x5a));
    const copyChunks: Array<{ bytes: number; capacity: number }> = [];
    const home = prepareCodexHome(
      [{ name: 'profile', command: 'server', env: { TOKEN: 'copy-secret' } }],
      'copy-agent',
      {
        env: {
          IDACC_MANAGED_SERVICE: '1',
          IDACC_DATA_DIR: profile,
          ID_AGENT_ID: 'copy-agent-id',
          CODEX_HOME: providerHome,
        },
        providerSharing: 'copy',
        providerCopyObserver: (bytes, capacity) => copyChunks.push({ bytes, capacity }),
        runId: 'copy-first',
      },
    )!;

    const auth = path.join(home, 'auth.json');
    expect(fs.lstatSync(auth).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(home, 'sessions', '2026', 'large.jsonl'))).toBe(false);
    expect(copyChunks.length).toBeGreaterThan(1);
    expect(copyChunks.every(({ bytes, capacity }) => (
      capacity === PRIVATE_COPY_BUFFER_BYTES
      && bytes > 0
      && bytes <= PRIVATE_COPY_BUFFER_BYTES
    ))).toBe(true);

    fs.writeFileSync(path.join(home, 'sessions', 'first-turn.jsonl'), 'owned-session');
    const second = prepareCodexHome(
      [],
      'renamed-copy-agent',
      managedContext(profile, providerHome, 'copy-agent-id', 'copy-second', 'copy'),
    )!;
    expect(fs.readFileSync(path.join(second, 'sessions', 'first-turn.jsonl'), 'utf8'))
      .toBe('owned-session');
  });

  it('fails closed instead of replacing an existing provider auth from an isolated copy', () => {
    const root = temporaryRoot('codex-auth-reconciliation');
    const providerHome = providerFixture(root);
    const profile = path.join(root, 'profile');
    fs.mkdirSync(profile);
    const homeA = prepareCodexHome(
      [],
      'agent-a',
      managedContext(profile, providerHome, 'agent-a', 'agent-a-first', 'copy'),
    )!;
    const authA = path.join(homeA, 'auth.json');
    const providerAuth = path.join(providerHome, 'auth.json');
    const snapshot = captureCodexAuthReconciliation(
      providerHome,
      path.dirname(homeA),
      homeA,
    )!;

    atomicWritePrivateFile(path.dirname(homeA), authA, '{"provider":"agent-a-refresh"}\n');
    expect(reconcileCodexAuthAfterRun(snapshot)).toBe('provider-conflict');
    expect(fs.readFileSync(providerAuth, 'utf8')).toContain('shared');

    const homeB = prepareCodexHome(
      [],
      'agent-b',
      managedContext(profile, providerHome, 'agent-b', 'agent-b-first', 'copy'),
    )!;
    expect(fs.readFileSync(path.join(homeB, 'auth.json'), 'utf8')).toContain('shared');
  });

  it('publishes first auth when the configured provider home starts logged out', () => {
    const root = temporaryRoot('codex-first-auth');
    const providerHome = path.join(root, 'provider');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(providerHome);
    fs.mkdirSync(profile);
    const home = prepareCodexHome(
      [],
      'first-auth',
      managedContext(profile, providerHome, 'first-auth-agent', 'first-auth-run', 'copy'),
    )!;
    const snapshot = captureCodexAuthReconciliation(
      providerHome,
      path.dirname(home),
      home,
    )!;
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(false);

    atomicWritePrivateFile(
      path.dirname(home),
      path.join(home, 'auth.json'),
      '{"provider":"first-login"}\n',
    );
    expect(reconcileCodexAuthAfterRun(snapshot)).toBe('run-refresh');
    expect(fs.readFileSync(path.join(providerHome, 'auth.json'), 'utf8'))
      .toContain('first-login');
  });

  it('preserves an external first login that wins during create-only publication', () => {
    const root = temporaryRoot('codex-first-auth-race');
    const providerHome = path.join(root, 'provider');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(providerHome);
    fs.mkdirSync(profile);
    const home = prepareCodexHome(
      [],
      'first-auth-race',
      managedContext(profile, providerHome, 'first-auth-race-agent', 'first-auth-race-run', 'copy'),
    )!;
    const providerAuth = path.join(providerHome, 'auth.json');
    const snapshot = captureCodexAuthReconciliation(
      providerHome,
      path.dirname(home),
      home,
      {
        onChunk: () => {
          if (!fs.existsSync(providerAuth)) {
            fs.writeFileSync(providerAuth, '{"provider":"external-login"}\n');
          }
        },
      },
    )!;
    atomicWritePrivateFile(
      path.dirname(home),
      path.join(home, 'auth.json'),
      `{"provider":"${'run-login'.repeat(20_000)}"}\n`,
    );

    expect(reconcileCodexAuthAfterRun(snapshot)).toBe('provider-conflict');
    expect(fs.readFileSync(providerAuth, 'utf8')).toContain('external-login');
  });

  it('does not delete an existing provider auth when an isolated run logs out', () => {
    const root = temporaryRoot('codex-run-logout-race');
    const providerHome = providerFixture(root);
    const profile = path.join(root, 'profile');
    fs.mkdirSync(profile);
    const home = prepareCodexHome(
      [],
      'run-logout',
      managedContext(profile, providerHome, 'run-logout-agent', 'run-logout', 'copy'),
    )!;
    const snapshot = captureCodexAuthReconciliation(
      providerHome,
      path.dirname(home),
      home,
    )!;
    fs.unlinkSync(path.join(home, 'auth.json'));

    expect(reconcileCodexAuthAfterRun(snapshot)).toBe('provider-conflict');
    expect(fs.readFileSync(path.join(providerHome, 'auth.json'), 'utf8')).toContain('shared');
  });

  it('preserves provider logout and concurrent provider changes during a run', () => {
    const root = temporaryRoot('codex-auth-conflicts');
    const providerHome = providerFixture(root);
    const profile = path.join(root, 'profile');
    fs.mkdirSync(profile);
    const logoutHome = prepareCodexHome(
      [],
      'logout',
      managedContext(profile, providerHome, 'logout-agent', 'logout-run', 'copy'),
    )!;
    const logoutSnapshot = captureCodexAuthReconciliation(
      providerHome,
      path.dirname(logoutHome),
      logoutHome,
    )!;
    atomicWritePrivateFile(
      path.dirname(logoutHome),
      path.join(logoutHome, 'auth.json'),
      '{"provider":"must-not-resurrect"}\n',
    );
    fs.unlinkSync(path.join(providerHome, 'auth.json'));
    expect(reconcileCodexAuthAfterRun(logoutSnapshot)).toBe('provider-logout');
    expect(fs.existsSync(path.join(providerHome, 'auth.json'))).toBe(false);
    expect(fs.existsSync(path.join(logoutHome, 'auth.json'))).toBe(false);

    fs.writeFileSync(path.join(providerHome, 'auth.json'), '{"provider":"launch-two"}\n');
    const conflictHome = prepareCodexHome(
      [],
      'conflict',
      managedContext(profile, providerHome, 'conflict-agent', 'conflict-run', 'copy'),
    )!;
    const conflictSnapshot = captureCodexAuthReconciliation(
      providerHome,
      path.dirname(conflictHome),
      conflictHome,
    )!;
    atomicWritePrivateFile(
      path.dirname(conflictHome),
      path.join(conflictHome, 'auth.json'),
      '{"provider":"stale-run-refresh"}\n',
    );
    atomicWritePrivateFile(
      providerHome,
      path.join(providerHome, 'auth.json'),
      '{"provider":"concurrent-login"}\n',
    );
    expect(reconcileCodexAuthAfterRun(conflictSnapshot)).toBe('provider-conflict');
    expect(fs.readFileSync(path.join(providerHome, 'auth.json'), 'utf8'))
      .toContain('concurrent-login');
  });

  it('fails closed on destination junction escapes and provider auth links', () => {
    const root = temporaryRoot('codex-links');
    const providerHome = providerFixture(root);
    const profile = path.join(root, 'profile');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(profile);
    fs.mkdirSync(outside);
    makeDirectoryLink(outside, path.join(profile, 'manager'));

    expect(() => prepareCodexHome(
      [{ name: 'profile', command: 'server', env: { TOKEN: 'must-not-write' } }],
      'agent',
      {
        env: {
          IDACC_MANAGED_SERVICE: '1',
          IDACC_DATA_DIR: profile,
          ID_AGENT_ID: 'agent-id',
          CODEX_HOME: providerHome,
        },
      },
    )).toThrow(/symlink|junction/i);
    expect(fs.readdirSync(outside)).toEqual([]);

    const safeProfile = path.join(root, 'safe-profile');
    const providerOutside = path.join(root, 'provider-outside');
    fs.mkdirSync(safeProfile);
    fs.mkdirSync(providerOutside);
    fs.unlinkSync(path.join(providerHome, 'auth.json'));
    fs.writeFileSync(path.join(providerOutside, 'auth.json'), '{"outside":true}\n');
    fs.symlinkSync(path.join(providerOutside, 'auth.json'), path.join(providerHome, 'auth.json'));
    expect(() => prepareCodexHome(
      [{ name: 'profile', command: 'server', env: { TOKEN: 'must-not-write' } }],
      'agent',
      {
        env: {
          IDACC_MANAGED_SERVICE: '1',
          IDACC_DATA_DIR: safeProfile,
          ID_AGENT_ID: 'agent-id',
          CODEX_HOME: providerHome,
        },
      },
    )).toThrow(/provider entry|symlink/i);
  });

  it('cleans a generated run without following a planted session link', () => {
    const root = temporaryRoot('codex-cleanup-link');
    const runsRoot = path.join(root, 'runs');
    const runHome = path.join(runsRoot, 'run-planted');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(runHome, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(runHome, 'config.toml'), 'secret = "remove-me"\n');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside-safe');
    makeDirectoryLink(outside, path.join(runHome, 'sessions'));

    removeCodexRunHomeNoFollow(runsRoot, runHome);
    expect(fs.existsSync(runHome)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('outside-safe');
  });

  it('fails closed in managed mode without a profile, stable id, or workspace', () => {
    const root = temporaryRoot('codex-no-home');
    expect(() => resolveCodexOverlayRoot({
      env: { IDACC_MANAGED_SERVICE: '1', HOME: root },
      homeDirectory: root,
    })).toThrow(/overlay storage is not configured/i);
    expect(() => prepareCodexHome(
      [{ name: 'profile', command: 'server', env: { TOKEN: 'must-not-write' } }],
      'agent',
      {
        env: {
          IDACC_MANAGED_SERVICE: '1',
          IDACC_DATA_DIR: root,
        },
        homeDirectory: root,
      },
    )).toThrow(/ID_AGENT_ID is required/i);
    expect(fs.existsSync(path.join(root, '.codex-idagents'))).toBe(false);
  });

  it('preserves configured-workspace and legacy standalone overlay roots', () => {
    const root = temporaryRoot('codex-standalone');
    const workspace = path.join(root, 'workspace');
    expect(resolveCodexOverlayRoot({
      env: {},
      homeDirectory: path.join(root, 'home'),
      workingDirectory: workspace,
    })).toBe(path.join(workspace, '.idacc', 'codex-overlays'));
    expect(resolveCodexOverlayRoot({
      env: {},
      homeDirectory: root,
    })).toBe(path.join(root, '.codex-idagents'));
  });
});
