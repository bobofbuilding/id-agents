// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { RuntimeLaneCooldownRecord, RuntimeLaneCooldownsRepository } from '../../db-service.js';

export class PgRuntimeLaneCooldownsRepo implements RuntimeLaneCooldownsRepository {
  constructor(private db: DbAdapter) {}

  async upsert(cooldown: RuntimeLaneCooldownRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO runtime_lane_cooldowns (
         lane_id, runtime, kind, cooling_until_ms, observed_at_ms, reason,
         team_id, agent_id, agent_name, query_id, reset_text, message
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT(lane_id) DO UPDATE SET
         runtime = EXCLUDED.runtime,
         kind = EXCLUDED.kind,
         cooling_until_ms = EXCLUDED.cooling_until_ms,
         observed_at_ms = EXCLUDED.observed_at_ms,
         reason = EXCLUDED.reason,
         team_id = EXCLUDED.team_id,
         agent_id = EXCLUDED.agent_id,
         agent_name = EXCLUDED.agent_name,
         query_id = EXCLUDED.query_id,
         reset_text = EXCLUDED.reset_text,
         message = EXCLUDED.message`,
      [
        cooldown.lane_id,
        cooldown.runtime,
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
      `SELECT lane_id, runtime, kind, cooling_until_ms, observed_at_ms, reason,
              team_id, agent_id, agent_name, query_id, reset_text, message
       FROM runtime_lane_cooldowns
       WHERE cooling_until_ms > $1
       ORDER BY lane_id`,
      [nowMs],
    );
    return rows;
  }

  async pruneExpired(nowMs: number): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM runtime_lane_cooldowns WHERE cooling_until_ms <= $1`,
      [nowMs],
    );
    return result.rowCount ?? 0;
  }
}
