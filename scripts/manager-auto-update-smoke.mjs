#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  backupSqliteState,
  localActiveQueryCount,
  parseArgs,
  sqliteFleetSnapshot,
  validateReleaseSnapshot,
} from './manager-auto-update.mjs';

const root = mkdtempSync(join(tmpdir(), 'id-agents-manager-update-'));
try {
  const parsed = parseArgs([
    '--target', root,
    '--source', 'https://example.invalid/id-agents.git',
    '--branch', 'stable',
    '--manager-url', 'http://127.0.0.1:4999/',
    '--state', join(root, 'state.json'),
    '--lock', join(root, 'lock'),
    '--dry-run',
    '--no-restart',
  ]);
  assert.equal(parsed.target, root);
  assert.equal(parsed.source, 'https://example.invalid/id-agents.git');
  assert.equal(parsed.branch, 'stable');
  assert.equal(parsed.managerUrl, 'http://127.0.0.1:4999');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.restart, false);

  validateReleaseSnapshot({
    version: '1.2.3',
    subject: 'v1.2.3: Ship guarded updates',
    changelog: '# Changelog\n\n## [1.2.3]\n',
    tags: ['v1.2.3'],
  });
  assert.throws(() => validateReleaseSnapshot({
    version: '1.2.3',
    subject: 'Ship guarded updates',
    changelog: '## [1.2.3]',
    tags: ['v1.2.3'],
  }), /subject/);
  assert.throws(() => validateReleaseSnapshot({
    version: '1.2.3',
    subject: 'v1.2.3: Ship guarded updates',
    changelog: '## [1.2.3]',
    tags: [],
  }), /tagged/);

  const databasePath = join(root, 'manager.db');
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE queries (status TEXT NOT NULL);
    CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, deleted_at INTEGER);
    INSERT INTO queries (status) VALUES ('pending'), ('processing'), ('completed');
    INSERT INTO teams (id, name) VALUES ('default-id', 'default'), ('custom-id', 'custom-team');
    INSERT INTO agents (id, team_id, deleted_at) VALUES ('agent-1', 'custom-id', NULL);
  `);
  database.close();
  assert.equal(await localActiveQueryCount({ HOME: root, SQLITE_PATH: databasePath }), 2);
  assert.equal(await localActiveQueryCount({ HOME: root, SQLITE_PATH: databasePath, DATABASE_URL: 'postgres://example' }), undefined);
  assert.deepEqual(sqliteFleetSnapshot({ HOME: root, SQLITE_PATH: databasePath })?.teams, [
    { name: 'custom-team', agentCount: 1 },
    { name: 'default', agentCount: 0 },
  ]);
  const backup = await backupSqliteState({ HOME: root, SQLITE_PATH: databasePath }, 2);
  assert.ok(backup && existsSync(backup));
  const updaterSource = readFileSync(new URL('./manager-auto-update.mjs', import.meta.url), 'utf8');
  assert.match(updaterSource, /current checkout is not a healthy installation/);
  assert.match(updaterSource, /reason: 'manager-unavailable'/);
  console.log('manager-auto-update smoke test passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
