// SPDX-License-Identifier: MIT
import type { DbAdapter } from '../../db-adapter.js';
import type { ControlStateRepository } from '../../db-service.js';
import type { ControlStateRow } from '../../types.js';
import { parseJsonObject, stringifyJson } from '../../db-json.js';
import { isDeepStrictEqual } from 'node:util';

function row(value: any): ControlStateRow {
  return { ...value, version: Number(value.version), created_at: Number(value.created_at), updated_at: Number(value.updated_at), value: parseJsonObject(value.value) };
}

export class SqliteControlStateRepo implements ControlStateRepository {
  constructor(private readonly db: DbAdapter) {}
  async get(teamId: string, scope: ControlStateRow['scope'], key: string): Promise<ControlStateRow | null> {
    const { rows } = await this.db.query<any>('SELECT * FROM control_state WHERE team_id=? AND scope=? AND state_key=?', [teamId, scope, key]);
    return rows[0] ? row(rows[0]) : null;
  }
  async list(teamId: string, scope: ControlStateRow['scope']): Promise<ControlStateRow[]> {
    const { rows } = await this.db.query<any>('SELECT * FROM control_state WHERE team_id=? AND scope=? ORDER BY updated_at DESC, state_key ASC', [teamId, scope]);
    return rows.map(row);
  }
  async upsert(input: { teamId: string; scope: ControlStateRow['scope']; key: string; value: Record<string, unknown>; expectedVersion?: number; now: number }): Promise<ControlStateRow | null> {
    const value = stringifyJson(input.value);
    const current = await this.get(input.teamId, input.scope, input.key);
    if (current) {
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) return null;
      if (isDeepStrictEqual(current.value, input.value)) return current;
    }
    if (input.expectedVersion === 0) {
      const inserted = await this.db.query(
        `INSERT INTO control_state(team_id,scope,state_key,value,version,created_at,updated_at) VALUES(?,?,?,?,1,?,?)
         ON CONFLICT(team_id,scope,state_key) DO NOTHING`,
        [input.teamId, input.scope, input.key, value, input.now, input.now],
      );
      return (inserted.rowCount ?? 0) > 0 ? this.get(input.teamId, input.scope, input.key) : null;
    }
    if (input.expectedVersion !== undefined) {
      const updated = await this.db.query(
        `UPDATE control_state SET value=?,version=version+1,updated_at=?
         WHERE team_id=? AND scope=? AND state_key=? AND version=?`,
        [value, input.now, input.teamId, input.scope, input.key, input.expectedVersion],
      );
      return (updated.rowCount ?? 0) > 0 ? this.get(input.teamId, input.scope, input.key) : null;
    }
    await this.db.query(
      `INSERT INTO control_state(team_id,scope,state_key,value,version,created_at,updated_at) VALUES(?,?,?,?,1,?,?)
       ON CONFLICT(team_id,scope,state_key) DO UPDATE SET value=excluded.value,version=control_state.version+1,updated_at=excluded.updated_at
       WHERE control_state.value <> excluded.value`,
      [input.teamId, input.scope, input.key, value, input.now, input.now],
    );
    return this.get(input.teamId, input.scope, input.key);
  }
  async delete(teamId: string, scope: ControlStateRow['scope'], key: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM control_state WHERE team_id=? AND scope=? AND state_key=?', [teamId, scope, key]);
    return (result.rowCount ?? 0) > 0;
  }
}
