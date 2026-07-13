// SPDX-License-Identifier: MIT

import Database from 'better-sqlite3';
import type { NonceStore } from './types.js';

/**
 * Durable, process-safe nonce store for deployed contributor decisions.
 * SQLite's primary-key constraint makes `consume` atomic across workers and
 * preserves replay state across process restarts. `InMemoryNonceStore` remains
 * available for unit tests only.
 */
export class SqliteNonceStore implements NonceStore {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement;

  constructor(filePath: string) {
    if (!filePath) throw new Error('nonce database path is required');
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 30000');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contributor_signing_nonces (
        delegation_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        consumed_at INTEGER NOT NULL,
        PRIMARY KEY (delegation_id, nonce)
      )
    `);
    this.insert = this.db.prepare(`
      INSERT OR IGNORE INTO contributor_signing_nonces (delegation_id, nonce, consumed_at)
      VALUES (?, ?, ?)
    `);
  }

  consume(delegationId: string, nonce: string): boolean {
    if (!delegationId || !nonce) return false;
    return this.insert.run(delegationId, nonce, Date.now()).changes === 1;
  }

  close(): void {
    this.db.close();
  }
}
