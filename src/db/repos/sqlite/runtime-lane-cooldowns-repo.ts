// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { RuntimeLaneCooldownRecord, RuntimeLaneCooldownsRepository } from '../../db-service.js';

export class SqliteRuntimeLaneCooldownsRepo implements RuntimeLaneCooldownsRepository {
  constructor(private db: DbAdapter) {}

  async upsert(cooldown: RuntimeLaneCooldownRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO runtime_lane_cooldowns (
         lane_id, runtime, runtime_namespace, kind, cooling_until_ms, observed_at_ms, reason,
         team_id, agent_id, agent_name, query_id, reset_text, message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(team_id, runtime_namespace, lane_id) DO UPDATE SET
         runtime = excluded.runtime,
         kind = excluded.kind,
         cooling_until_ms = excluded.cooling_until_ms,
         observed_at_ms = excluded.observed_at_ms,
         reason = excluded.reason,
         team_id = excluded.team_id,
         agent_id = excluded.agent_id,
         agent_name = excluded.agent_name,
         query_id = excluded.query_id,
         reset_text = excluded.reset_text,
         message = excluded.message`,
      [
        cooldown.lane_id,
        cooldown.runtime,
        cooldown.runtime_namespace,
        cooldown.kind,
        cooldown.cooling_until_ms,
        cooldown.observed_at_ms,
        cooldown.reason,
        cooldown.team_id,
        cooldown.agent_id,
        cooldown.agent_name,
        cooldown.query_id,
        cooldown.reset_text,
        cooldown.message,
      ],
    );
  }

  async listActive(nowMs: number): Promise<RuntimeLaneCooldownRecord[]> {
    const { rows } = await this.db.query<RuntimeLaneCooldownRecord>(
      `SELECT lane_id, runtime, runtime_namespace, kind, cooling_until_ms, observed_at_ms, reason,
              team_id, agent_id, agent_name, query_id, reset_text, message
       FROM runtime_lane_cooldowns
       WHERE cooling_until_ms > ?
       ORDER BY team_id, runtime_namespace, lane_id`,
      [nowMs],
    );
    return rows;
  }

  async pruneExpired(nowMs: number): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM runtime_lane_cooldowns WHERE cooling_until_ms <= ?`,
      [nowMs],
    );
    return result.rowCount ?? 0;
  }
}
