#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { localActiveQueryCount, parseArgs, validateReleaseSnapshot } from './manager-auto-update.mjs';

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
    INSERT INTO queries (status) VALUES ('pending'), ('processing'), ('completed');
  `);
  database.close();
  assert.equal(await localActiveQueryCount({ HOME: root, SQLITE_PATH: databasePath }), 2);
  assert.equal(await localActiveQueryCount({ HOME: root, SQLITE_PATH: databasePath, DATABASE_URL: 'postgres://example' }), undefined);
  console.log('manager-auto-update smoke test passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
