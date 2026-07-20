// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';

const originalBusyTimeout = process.env.ID_SQLITE_BUSY_TIMEOUT_MS;

afterEach(() => {
  if (originalBusyTimeout == null) delete process.env.ID_SQLITE_BUSY_TIMEOUT_MS;
  else process.env.ID_SQLITE_BUSY_TIMEOUT_MS = originalBusyTimeout;
});

describe('SqliteAdapter lock handling', () => {
  it('uses a short synchronous busy timeout so lock retries can yield to HTTP work', async () => {
    delete process.env.ID_SQLITE_BUSY_TIMEOUT_MS;
    const adapter = new SqliteAdapter(':memory:');
    const { rows } = await adapter.query<{ timeout: number }>(
      'SELECT timeout FROM pragma_busy_timeout',
    );
    expect(rows[0]?.timeout).toBe(250);
    await adapter.close();
  });
});
