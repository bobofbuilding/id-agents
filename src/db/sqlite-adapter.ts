// SPDX-License-Identifier: MIT

import Database from 'better-sqlite3';
import { DbAdapter, QueryResult } from './db-adapter.js';

const DEFAULT_BUSY_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_RETRY_WINDOW_MS = 30_000;
const MAX_LOCK_RETRY_DELAY_MS = 750;
const DEFAULT_SLOW_QUERY_MS = 500;

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isSqliteLockError(err: unknown): boolean {
  const code = typeof (err as any)?.code === 'string' ? (err as any).code : '';
  const message = String((err as any)?.message || err || '');
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || /\bdatabase is locked\b/i.test(message)
    || /\bdatabase table is locked\b/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SqliteAdapter implements DbAdapter {
  readonly dialect = 'sqlite' as const;
  private db: Database.Database;
  private readonly lockRetryWindowMs: number;
  private readonly slowQueryMs: number;

  constructor(filePath: string) {
    const busyTimeoutMs = positiveEnvInt('ID_SQLITE_BUSY_TIMEOUT_MS', DEFAULT_BUSY_TIMEOUT_MS);
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    this.db.pragma('synchronous = NORMAL');
    this.lockRetryWindowMs = positiveEnvInt('ID_SQLITE_LOCK_RETRY_MS', DEFAULT_LOCK_RETRY_WINDOW_MS);
    this.slowQueryMs = positiveEnvInt('ID_SQLITE_SLOW_QUERY_MS', DEFAULT_SLOW_QUERY_MS);
  }

  /**
   * Normalise Postgres-style positional params ($1, $2, …) to SQLite-style (?)
   * so that the same SQL can be used across both adapters.
   * Named params that are NOT numeric (e.g. $name) are left untouched.
   */
  private normaliseSql(sql: string): string {
    return sql.replace(/\$(\d+)/g, '?');
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const normSql = this.normaliseSql(sql);
    const started = Date.now();
    let attempt = 0;

    while (true) {
      try {
        const stmt = this.db.prepare(normSql);

        if (/^\s*(SELECT|WITH)\b/i.test(normSql) || /\bRETURNING\b/i.test(normSql)) {
          const rows = stmt.all(...params) as T[];
          this.warnIfSlow(normSql, started, rows.length);
          return { rows, rowCount: rows.length };
        }

        const info = stmt.run(...params);
        this.warnIfSlow(normSql, started, info.changes);
        return { rows: [] as T[], rowCount: info.changes };
      } catch (err) {
        if (!isSqliteLockError(err)) throw err;
        const elapsed = Date.now() - started;
        if (elapsed >= this.lockRetryWindowMs) throw err;
        const backoff = Math.min(MAX_LOCK_RETRY_DELAY_MS, 25 * 2 ** Math.min(attempt, 5));
        const remaining = Math.max(0, this.lockRetryWindowMs - elapsed);
        await sleep(Math.min(backoff, remaining));
        attempt += 1;
      }
    }
  }

  private warnIfSlow(sql: string, started: number, rowCount: number): void {
    const elapsedMs = Date.now() - started;
    if (elapsedMs < this.slowQueryMs) return;
    const summary = sql.replace(/\s+/g, ' ').trim().slice(0, 240);
    console.warn(`[SQLite] slow query ${elapsedMs}ms rows=${rowCount}: ${summary}`);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}
