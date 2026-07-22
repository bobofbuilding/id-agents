// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { TasksRepository } from '../../db-service.js';
import type { TaskRow } from '../../types.js';

export class PgTasksRepo implements TasksRepository {
  constructor(private readonly db: DbAdapter) {}

  async create(task: TaskRow, eventScheduleIds?: string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO tasks
         (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, project_id, plan_id,
          workflow_state, workflow_contract, assignment_id, delegation_lineage, blocked_detail, validation_detail, outcome_detail, lifecycle_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        task.id,
        task.name,
        task.uuid,
        task.team_id,
        task.title,
        task.description,
        task.status,
        task.created_by,
        task.owner,
        task.created_at,
        task.updated_at,
        task.completed_at,
        task.project_id ?? null,
        task.plan_id ?? null,
        task.workflow_state ?? null,
        task.workflow_contract ?? null,
        task.assignment_id ?? null,
        task.delegation_lineage ?? null,
        task.blocked_detail ?? null,
        task.validation_detail ?? null,
        task.outcome_detail ?? null,
        task.lifecycle_updated_at ?? null,
      ],
    );

    if (eventScheduleIds && eventScheduleIds.length > 0) {
      const now = task.created_at;
      for (const scheduleId of eventScheduleIds) {
        await this.db.query(
          `INSERT INTO task_event_links (task_id, schedule_id, created_at) VALUES ($1, $2, $3)`,
          [task.id, scheduleId, now],
        );
      }
    }
  }

  async getByName(name: string): Promise<TaskRow | null> {
    const r = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE name = $1`,
      [name],
    );
    return r.rows[0] || null;
  }

  async getByNameForTeam(name: string, teamId: string): Promise<TaskRow | null> {
    const r = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE name = $1 AND team_id = $2`,
      [name, teamId],
    );
    return r.rows[0] || null;
  }

  async getByUuidPrefix(prefix: string): Promise<TaskRow[]> {
    const r = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE uuid LIKE $1 ORDER BY updated_at DESC`,
      [`${prefix}%`],
    );
    return r.rows;
  }

  async list(filters?: {
    status?: 'todo' | 'doing' | 'done';
    workflowState?: TaskRow['workflow_state'] | null;
    owner?: string;
    teamId?: string | null;
    limit?: number;
    order?: 'updated_desc' | 'updated_asc';
  }): Promise<TaskRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filters?.status) {
      clauses.push(`status = $${idx++}`);
      params.push(filters.status);
    }
    if (filters?.workflowState !== undefined) {
      if (filters.workflowState === null) {
        clauses.push('workflow_state IS NULL');
      } else {
        clauses.push(`workflow_state = $${idx++}`);
        params.push(filters.workflowState);
      }
    }
    if (filters?.owner) {
      clauses.push(`owner = $${idx++}`);
      params.push(filters.owner);
    }
    if (filters?.teamId !== undefined) {
      if (filters.teamId === null) {
        clauses.push('team_id IS NULL');
      } else {
        clauses.push(`team_id = $${idx++}`);
        params.push(filters.teamId);
      }
    }

    const limit = filters?.limit && Number.isFinite(filters.limit)
      ? Math.max(1, Math.min(500, Math.floor(filters.limit)))
      : 0;
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    if (limit) params.push(limit);
    const order = filters?.order === 'updated_asc' ? 'ASC' : 'DESC';
    const r = await this.db.query<TaskRow>(
      `SELECT * FROM tasks ${where} ORDER BY updated_at ${order}${limit ? ` LIMIT $${idx++}` : ''}`,
      params,
    );
    return r.rows;
  }

  async updateFields(
    taskId: string,
    fields: {
      team_id?: string | null;
      owner?: string | null;
      status?: 'todo' | 'doing' | 'done';
      title?: string;
      description?: string | null;
      completed_at?: number | null;
      workflow_state?: TaskRow['workflow_state'];
      workflow_contract?: TaskRow['workflow_contract'];
      assignment_id?: string | null;
      delegation_lineage?: TaskRow['delegation_lineage'];
      blocked_detail?: TaskRow['blocked_detail'];
      validation_detail?: TaskRow['validation_detail'];
      outcome_detail?: TaskRow['outcome_detail'];
      lifecycle_updated_at?: number | null;
      updated_at: number;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    sets.push(`updated_at = $${idx++}`);
    params.push(fields.updated_at);

    if (fields.team_id !== undefined) { sets.push(`team_id = $${idx++}`); params.push(fields.team_id); }
    if (fields.owner !== undefined) { sets.push(`owner = $${idx++}`); params.push(fields.owner); }
    if (fields.status !== undefined) { sets.push(`status = $${idx++}`); params.push(fields.status); }
    if (fields.status === 'doing') {
      if (fields.workflow_state === undefined) {
        sets.push("workflow_state = 'executing'");
      }
      if (fields.blocked_detail === undefined) {
        sets.push('blocked_detail = NULL');
      }
      if (fields.lifecycle_updated_at === undefined) {
        sets.push(`lifecycle_updated_at = $${idx++}`);
        params.push(fields.updated_at);
      }
    } else if (fields.status === 'done') {
      if (fields.workflow_state === undefined) {
        sets.push("workflow_state = 'validated'");
      }
      if (fields.blocked_detail === undefined) {
        sets.push('blocked_detail = NULL');
      }
      if (fields.lifecycle_updated_at === undefined) {
        sets.push(`lifecycle_updated_at = $${idx++}`);
        params.push(fields.updated_at);
      }
    }
    if (fields.title !== undefined) { sets.push(`title = $${idx++}`); params.push(fields.title); }
    if (fields.description !== undefined) { sets.push(`description = $${idx++}`); params.push(fields.description); }
    if (fields.completed_at !== undefined) { sets.push(`completed_at = $${idx++}`); params.push(fields.completed_at); }
    if (fields.workflow_state !== undefined) { sets.push(`workflow_state = $${idx++}`); params.push(fields.workflow_state); }
    if (fields.workflow_contract !== undefined) { sets.push(`workflow_contract = $${idx++}`); params.push(fields.workflow_contract); }
    if (fields.assignment_id !== undefined) { sets.push(`assignment_id = $${idx++}`); params.push(fields.assignment_id); }
    if (fields.delegation_lineage !== undefined) { sets.push(`delegation_lineage = $${idx++}`); params.push(fields.delegation_lineage); }
    if (fields.blocked_detail !== undefined) { sets.push(`blocked_detail = $${idx++}`); params.push(fields.blocked_detail); }
    if (fields.validation_detail !== undefined) { sets.push(`validation_detail = $${idx++}`); params.push(fields.validation_detail); }
    if (fields.outcome_detail !== undefined) { sets.push(`outcome_detail = $${idx++}`); params.push(fields.outcome_detail); }
    if (fields.lifecycle_updated_at !== undefined) { sets.push(`lifecycle_updated_at = $${idx++}`); params.push(fields.lifecycle_updated_at); }

    params.push(taskId);
    await this.db.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${idx}`,
      params,
    );
  }

  async claim(
    taskId: string,
    ownerId: string,
    updatedAt: number,
    options?: {
      maxDoingForTeam?: number;
      workflow?: { assignmentId: string; lineage: Record<string, unknown> };
    },
  ): Promise<boolean> {
    // A pre-assigned todo row (owner set by auto-routing, status still
    // 'todo') must be claimable by that same owner — otherwise it's a dead
    // state nobody can flip to 'doing'. Only a *different* owner is
    // rejected by the `owner IS NULL OR owner = $2` condition below.
    const limit = options?.maxDoingForTeam;
    const workflow = options?.workflow;
    if (limit !== undefined) {
      const r = await this.db.query(
        `UPDATE tasks AS target
         SET owner = $2, status = 'doing', updated_at = $3,
             workflow_state = 'executing', blocked_detail = NULL,
             assignment_id = $5,
             delegation_lineage = $6::jsonb,
             lifecycle_updated_at = $3
         WHERE target.id = $1 AND (target.owner IS NULL OR target.owner = $2) AND target.status = 'todo'
           AND (
             SELECT COUNT(*)
             FROM tasks active
             WHERE active.status = 'doing'
               AND (
                 active.team_id = target.team_id
                 OR (active.team_id IS NULL AND target.team_id IS NULL)
               )
           ) < $4`,
        [taskId, ownerId, updatedAt, limit, workflow?.assignmentId ?? null, workflow?.lineage ?? null],
      );
      return r.rowCount > 0;
    }

    const r = await this.db.query(
      `UPDATE tasks
       SET owner = $2, status = 'doing', updated_at = $3,
           workflow_state = 'executing', blocked_detail = NULL,
           assignment_id = $4,
           delegation_lineage = $5::jsonb,
           lifecycle_updated_at = $3
       WHERE id = $1 AND (owner IS NULL OR owner = $2) AND status = 'todo'`,
      [taskId, ownerId, updatedAt, workflow?.assignmentId ?? null, workflow?.lineage ?? null],
    );
    return r.rowCount > 0;
  }

  async releaseClaim(
    taskId: string,
    ownerId: string,
    claimedAt: number,
    updatedAt: number,
  ): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE tasks
       SET owner = NULL, status = 'todo', completed_at = NULL,
           workflow_state = 'queued', assignment_id = NULL, delegation_lineage = NULL,
           blocked_detail = NULL, lifecycle_updated_at = $4, updated_at = $4
       WHERE id = $1 AND owner = $2 AND status = 'doing' AND updated_at = $3`,
      [taskId, ownerId, claimedAt, updatedAt],
    );
    return r.rowCount > 0;
  }

  async delete(taskId: string): Promise<void> {
    await this.db.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
  }

  async replaceEventLinks(taskId: string, scheduleIds: string[]): Promise<void> {
    await this.db.query(
      `DELETE FROM task_event_links WHERE task_id = $1`,
      [taskId],
    );
    const now = Math.floor(Date.now() / 1000);
    for (const scheduleId of scheduleIds) {
      await this.db.query(
        `INSERT INTO task_event_links (task_id, schedule_id, created_at) VALUES ($1, $2, $3)`,
        [taskId, scheduleId, now],
      );
    }
  }

  async listEventLinksForTask(taskId: string): Promise<Array<{ schedule_id: string }>> {
    const r = await this.db.query<{ schedule_id: string }>(
      `SELECT schedule_id FROM task_event_links WHERE task_id = $1`,
      [taskId],
    );
    return r.rows;
  }

  async listTasksForSchedule(scheduleId: string): Promise<TaskRow[]> {
    const r = await this.db.query<TaskRow>(
      `SELECT t.* FROM tasks t
       JOIN task_event_links tel ON tel.task_id = t.id
       WHERE tel.schedule_id = $1
       ORDER BY t.updated_at DESC`,
      [scheduleId],
    );
    return r.rows;
  }
}
