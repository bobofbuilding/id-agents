// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../../src/db/index.js';

describe('SQLite profile path selection', () => {
  const originalHome = process.env.HOME;
  const originalSqlitePath = process.env.SQLITE_PATH;
  const scratchRoots: string[] = [];

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSqlitePath === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = originalSqlitePath;
    for (const scratch of scratchRoots.splice(0)) {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('does not recreate the legacy home directory when SQLITE_PATH is profile-local', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'id-agents-sqlite-path-'));
    scratchRoots.push(scratch);
    const home = join(scratch, 'home');
    const profileDatabase = join(scratch, 'profile', 'manager', 'id-agents.db');
    const legacyDataDirectory = join(home, '.id-agents');
    process.env.HOME = home;
    process.env.SQLITE_PATH = profileDatabase;

    const db = await createDb();
    await db.close();

    expect(existsSync(profileDatabase)).toBe(true);
    expect(existsSync(legacyDataDirectory)).toBe(false);
  });
});
