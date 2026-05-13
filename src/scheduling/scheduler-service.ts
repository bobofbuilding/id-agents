// SPDX-License-Identifier: MIT

import type { Db } from '../db/db-service.js';
import type { ScheduleDefinitionRow, ScheduleRunRow } from '../db/types.js';
import type { DueRun, DispatchTarget, LinkedTaskSummary, DispatchResult } from './schedule-types.js';
import { evaluateIntervalSchedule, evaluateCalendarSchedule } from './schedule-evaluator.js';
import { ScheduleDispatcher } from './schedule-dispatcher.js';
import { HEARTBEAT_GENERIC_MESSAGE } from './schedule-config.js';

export class SchedulerService {
  private lastTickAtSec = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly dispatcher: ScheduleDispatcher;

  constructor(
    private readonly db: Db,
    private readonly resolveAgent: (agentId: string) => Promise<DispatchTarget | null>,
  ) {
    this.dispatcher = new ScheduleDispatcher();
  }

  start(): void {
    if (this.timer) return;
    console.log('[Scheduler] Starting (30s tick interval)');
    this.timer = setInterval(() => {
      void this.tick();
    }, 30_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[Scheduler] Stopped');
    }
  }

  async tick(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = this.lastTickAtSec;
    const windowEnd = nowSec;

    try {
      const defs = await this.db.schedules.listActiveDefinitions();
      const defsById = new Map(defs.map((def) => [def.id, def]));

      const allDueRuns: DueRun[] = [];
      for (const def of defs) {
        const runs = def.kind === 'heartbeat'
          ? evaluateIntervalSchedule(def, windowStart, windowEnd)
          : evaluateCalendarSchedule(def, windowStart, windowEnd);
        allDueRuns.push(...runs);
      }

      for (const run of allDueRuns) {
        const def = defsById.get(run.scheduleId);
        if (!def) continue;

        const agentIds = await this.db.schedules.listTargets(run.scheduleId);

        for (const agentId of agentIds) {
          if (def.max_runs != null) {
            const sentCount = await this.db.schedules.countRuns(run.scheduleId, agentId);
            if (sentCount >= def.max_runs) {
              console.log(`[Scheduler] ${def.title}: agent ${agentId} reached max_runs (${def.max_runs}), skipping`);
              continue;
            }
          }

          const runRow: ScheduleRunRow = {
            schedule_id: run.scheduleId,
            agent_id: agentId,
            scheduled_key: run.scheduledKey,
            scheduled_at: run.scheduledAt,
            fired_at: nowSec,
            status: 'pending',
            error: null,
          };

          const inserted = await this.db.schedules.insertRun(runRow);
          if (!inserted) continue;

          const target = await this.resolveAgent(agentId);
          if (!target) {
            await this.db.schedules.updateRunStatus(run.scheduleId, agentId, run.scheduledKey, 'skipped', 'Agent not found');
            continue;
          }

          // Load linked tasks for calendar schedules
          let linkedTasks: LinkedTaskSummary[] | undefined;
          if (def.kind === 'calendar') {
            try {
              const taskRows = await this.db.tasks.listTasksForSchedule(def.id);
              if (taskRows.length > 0) {
                linkedTasks = [];
                for (const t of taskRows) {
                  let ownerName: string | null = null;
                  if (t.owner) {
                    const ownerAgent = await this.db.agents.getById(t.owner);
                    if (ownerAgent) ownerName = (ownerAgent.metadata as any)?.alias || ownerAgent.name;
                  }
                  let teamName: string | null = null;
                  if (t.team_id) {
                    const teamRow = await this.db.teams.getTeam(t.team_id);
                    if (teamRow) teamName = teamRow.name;
                  }
                  linkedTasks.push({ name: t.name, title: t.title, status: t.status, owner: ownerName, team: teamName });
                }
              }
            } catch {
              // best-effort: don't block dispatch if task lookup fails
            }
          }

          const result = await this.dispatcher.dispatch(def, target, run.scheduledKey, linkedTasks);
          if (result.success) {
            await this.db.schedules.updateRunStatus(run.scheduleId, agentId, run.scheduledKey, 'sent');
            console.log(`[Scheduler] ${def.title} -> ${target.name} (${run.scheduledKey})`);
          } else {
            await this.db.schedules.updateRunStatus(run.scheduleId, agentId, run.scheduledKey, 'failed', result.error ?? null);
            console.log(`[Scheduler] ${def.title} -> ${target.name} FAILED: ${result.error}`);
          }
        }
      }
    } catch (err: any) {
      console.log(`[Scheduler] Tick error: ${err.message}`);
    }

    this.lastTickAtSec = windowEnd;
  }

  async seedSchedule(def: ScheduleDefinitionRow, agentIds: string[]): Promise<void> {
    await this.db.schedules.upsertDefinition(def);
    await this.db.schedules.replaceTargets(def.id, agentIds);
    console.log(`[Scheduler] Seeded schedule "${def.title}" -> [${agentIds.join(', ')}]`);
  }

  async removeAgentSchedules(agentId: string): Promise<void> {
    await this.db.schedules.deleteBySource('yaml', `heartbeat:${agentId}`);
  }

  /**
   * Manual operator fire (`/heartbeat fire <agent>`).
   *
   * Per the cto-approved spec:
   *   - The wake payload is built via the shared `buildSchedulePayload`
   *     helper so it is byte-identical to a scheduler-driven fire
   *     except for the scheduled-key timestamp and the `manual: true`
   *     flag.
   *   - **No DB mutation.** No `schedule_runs` row is inserted, the
   *     definition's `last_fire_at` / cadence is untouched, and the
   *     fire is NOT counted against `max_runs`. Manual fires are an
   *     out-of-band probe, not part of the scheduler's logical history.
   *
   * Returns the dispatcher's result so callers can surface delivery
   * failures (agent not running, missing endpoint, HTTP error) without
   * having to instrument the dispatch path themselves.
   */
  async fireManual(
    def: ScheduleDefinitionRow,
    target: DispatchTarget,
  ): Promise<DispatchResult> {
    const nowSec = Math.floor(Date.now() / 1000);
    // Manual scheduledKey reuses the scheduled-fire shape (`interval:<ts>`
    // for heartbeats, `manual:<ts>` for synthesized forced fires) so the
    // slice-3 parity test can simply strip the timestamp and `manual`
    // flag and compare the two payloads byte-for-byte.
    const scheduledKey = def.kind === 'heartbeat'
      ? `interval:${nowSec}`
      : `manual:${nowSec}`;
    return this.dispatcher.dispatch(def, target, scheduledKey, { manual: true });
  }
}

/**
 * Synthesize a generic in-memory heartbeat schedule definition for an
 * agent that has no real heartbeat configured. Used by `/heartbeat
 * fire <agent> --force` so operators can wake an agent that doesn't
 * have a HEARTBEAT.yaml/HEARTBEAT.md — the synthesized definition is
 * NEVER persisted, it exists only to feed the wake payload.
 *
 * The shape mirrors `heartbeatToSchedule` so the dispatcher path sees
 * a normal definition row; the only differences are a `force_` id
 * prefix (so future debugging can tell synthesized rows apart from
 * real ones, even though they never hit the DB) and a default 60s
 * interval (the minimum the validator allows — placeholder value
 * since the row is never persisted and cadence is irrelevant).
 */
export function synthesizeForceHeartbeat(
  agentId: string,
  agentName: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): ScheduleDefinitionRow {
  return {
    id: `force_hb_${agentId}`,
    kind: 'heartbeat',
    title: `Heartbeat: ${agentName}`,
    description: null,
    active: true,
    message: HEARTBEAT_GENERIC_MESSAGE,
    sender: 'heartbeat',
    delivery_mode: 'internal',
    timezone: null,
    catch_up_policy: 'fire_once',
    dedupe_window_seconds: 90,
    interval_seconds: 60,
    anchor_at: nowSec,
    max_runs: null,
    expires_at: null,
    local_time_seconds: null,
    local_date: null,
    days_of_week: null,
    source_type: 'yaml',
    source_key: `heartbeat:${agentId}`,
    created_at: nowSec,
    updated_at: nowSec,
  };
}
