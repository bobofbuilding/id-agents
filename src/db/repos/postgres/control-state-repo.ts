// SPDX-License-Identifier: MIT
import type { DbAdapter } from '../../db-adapter.js';
import type { ControlStateRepository } from '../../db-service.js';
import type { ControlStateRow } from '../../types.js';
import { parseJsonObject, stringifyJson } from '../../db-json.js';
import { isDeepStrictEqual } from 'node:util';

function row(value: any): ControlStateRow {
  return { ...value, version: Number(value.version), created_at: Number(value.created_at), updated_at: Number(value.updated_at), value: parseJsonObject(value.value) };
}

export class PgControlStateRepo implements ControlStateRepository {
  constructor(private readonly db: DbAdapter) {}
  async get(teamId: string, scope: ControlStateRow['scope'], key: string): Promise<ControlStateRow | null> {
    const { rows } = await this.db.query<any>('SELECT * FROM control_state WHERE team_id=$1 AND scope=$2 AND state_key=$3', [teamId, scope, key]);
    return rows[0] ? row(rows[0]) : null;
  }
  async list(teamId: string, scope: ControlStateRow['scope']): Promise<ControlStateRow[]> {
    const { rows } = await this.db.query<any>('SELECT * FROM control_state WHERE team_id=$1 AND scope=$2 ORDER BY updated_at DESC, state_key ASC', [teamId, scope]);
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
        `INSERT INTO control_state(team_id,scope,state_key,value,version,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,1,$5,$5)
         ON CONFLICT(team_id,scope,state_key) DO NOTHING`,
        [input.teamId, input.scope, input.key, value, input.now],
      );
      return (inserted.rowCount ?? 0) > 0 ? this.get(input.teamId, input.scope, input.key) : null;
    }
    if (input.expectedVersion !== undefined) {
      const updated = await this.db.query(
        `UPDATE control_state SET value=$1::jsonb,version=version+1,updated_at=$2
         WHERE team_id=$3 AND scope=$4 AND state_key=$5 AND version=$6`,
        [value, input.now, input.teamId, input.scope, input.key, input.expectedVersion],
      );
      return (updated.rowCount ?? 0) > 0 ? this.get(input.teamId, input.scope, input.key) : null;
    }
    await this.db.query(
      `INSERT INTO control_state(team_id,scope,state_key,value,version,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,1,$5,$5)
       ON CONFLICT(team_id,scope,state_key) DO UPDATE SET value=EXCLUDED.value,version=control_state.version+1,updated_at=EXCLUDED.updated_at
       WHERE control_state.value IS DISTINCT FROM EXCLUDED.value`,
      [input.teamId, input.scope, input.key, value, input.now],
    );
    return this.get(input.teamId, input.scope, input.key);
  }
  async delete(
    teamId: string,
    scope: ControlStateRow['scope'],
    key: string,
    expectedVersion: number,
  ): Promise<'deleted' | 'not_found' | 'version_conflict'> {
    const result = await this.db.query(
      'DELETE FROM control_state WHERE team_id=$1 AND scope=$2 AND state_key=$3 AND version=$4',
      [teamId, scope, key, expectedVersion],
    );
    if ((result.rowCount ?? 0) > 0) return 'deleted';
    return await this.get(teamId, scope, key) ? 'version_conflict' : 'not_found';
  }
}
