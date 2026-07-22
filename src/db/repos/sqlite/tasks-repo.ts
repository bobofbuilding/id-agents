// SPDX-License-Identifier: MIT

import type { DbAdapter } from '../../db-adapter.js';
import type { TasksRepository } from '../../db-service.js';
import type { TaskRow } from '../../types.js';
import { parseJsonObject, stringifyJson } from '../../db-json.js';

function taskRow(row: TaskRow): TaskRow {
  const optionalJson = (value: unknown): Record<string, unknown> | null =>
    value === null || value === undefined || value === '' ? null : parseJsonObject(value);
  return {
    ...row,
    workflow_contract: optionalJson(row.workflow_contract),
    delegation_lineage: optionalJson(row.delegation_lineage),
    blocked_detail: optionalJson(row.blocked_detail),
    validation_detail: optionalJson(row.validation_detail),
    outcome_detail: optionalJson(row.outcome_detail),
  };
}

export class SqliteTasksRepo implements TasksRepository {
  constructor(private readonly db: DbAdapter) {}

  async create(task: TaskRow, eventScheduleIds?: string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO tasks
         (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, project_id, plan_id,
          workflow_state, workflow_contract, assignment_id, delegation_lineage, blocked_detail, validation_detail, outcome_detail, lifecycle_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        task.workflow_contract ? stringifyJson(task.workflow_contract) : null,
        task.assignment_id ?? null,
        task.delegation_lineage ? stringifyJson(task.delegation_lineage) : null,
        task.blocked_detail ? stringifyJson(task.blocked_detail) : null,
        task.validation_detail ? stringifyJson(task.validation_detail) : null,
        task.outcome_detail ? stringifyJson(task.outcome_detail) : null,
        task.lifecycle_updated_at ?? null,
      ],
    );

    if (eventScheduleIds && eventScheduleIds.length > 0) {
      const now = task.created_at;
      for (const scheduleId of eventScheduleIds) {
        await this.db.query(
          `INSERT INTO task_event_links (task_id, schedule_id, created_at) VALUES (?, ?, ?)`,
          [task.id, scheduleId, now],
        );
      }
    }
  }

  async getByName(name: string): Promise<TaskRow | null> {
    const { rows } = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE name = ?`,
      [name],
    );
    return rows[0] ? taskRow(rows[0]) : null;
  }

  async getByNameForTeam(name: string, teamId: string): Promise<TaskRow | null> {
    const { rows } = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE name = ? AND team_id = ?`,
      [name, teamId],
    );
    return rows[0] ? taskRow(rows[0]) : null;
  }

  async getByUuidPrefix(prefix: string): Promise<TaskRow[]> {
    const { rows } = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE uuid LIKE ? ORDER BY updated_at DESC`,
      [`${prefix}%`],
    );
    return rows.map(taskRow);
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

    if (filters?.status) {
      clauses.push('status = ?');
      params.push(filters.status);
    }
    if (filters?.workflowState !== undefined) {
      if (filters.workflowState === null) {
        clauses.push('workflow_state IS NULL');
      } else {
        clauses.push('workflow_state = ?');
        params.push(filters.workflowState);
      }
    }
    if (filters?.owner) {
      clauses.push('owner = ?');
      params.push(filters.owner);
    }
    if (filters?.teamId !== undefined) {
      if (filters.teamId === null) {
        clauses.push('team_id IS NULL');
      } else {
        clauses.push('team_id = ?');
        params.push(filters.teamId);
      }
    }

    const limit = filters?.limit && Number.isFinite(filters.limit)
      ? Math.max(1, Math.min(500, Math.floor(filters.limit)))
      : 0;
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = filters?.order === 'updated_asc' ? 'ASC' : 'DESC';
    const { rows } = await this.db.query<TaskRow>(
      `SELECT * FROM tasks ${where} ORDER BY updated_at ${order}${limit ? ' LIMIT ?' : ''}`,
      limit ? [...params, limit] : params,
    );
    return rows.map(taskRow);
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
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [fields.updated_at];

    if (fields.team_id !== undefined) { sets.push('team_id = ?'); params.push(fields.team_id); }
    if (fields.owner !== undefined) { sets.push('owner = ?'); params.push(fields.owner); }
    if (fields.status !== undefined) { sets.push('status = ?'); params.push(fields.status); }
    if (fields.status === 'doing') {
      if (fields.workflow_state === undefined) {
        sets.push("workflow_state = 'executing'");
      }
      if (fields.blocked_detail === undefined) {
        sets.push('blocked_detail = NULL');
      }
      if (fields.lifecycle_updated_at === undefined) {
        sets.push('lifecycle_updated_at = ?');
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
        sets.push('lifecycle_updated_at = ?');
        params.push(fields.updated_at);
      }
    }
    if (fields.title !== undefined) { sets.push('title = ?'); params.push(fields.title); }
    if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description); }
    if (fields.completed_at !== undefined) { sets.push('completed_at = ?'); params.push(fields.completed_at); }
    if (fields.workflow_state !== undefined) { sets.push('workflow_state = ?'); params.push(fields.workflow_state); }
    if (fields.workflow_contract !== undefined) { sets.push('workflow_contract = ?'); params.push(fields.workflow_contract ? stringifyJson(fields.workflow_contract) : null); }
    if (fields.assignment_id !== undefined) { sets.push('assignment_id = ?'); params.push(fields.assignment_id); }
    if (fields.delegation_lineage !== undefined) { sets.push('delegation_lineage = ?'); params.push(fields.delegation_lineage ? stringifyJson(fields.delegation_lineage) : null); }
    if (fields.blocked_detail !== undefined) { sets.push('blocked_detail = ?'); params.push(fields.blocked_detail ? stringifyJson(fields.blocked_detail) : null); }
    if (fields.validation_detail !== undefined) { sets.push('validation_detail = ?'); params.push(fields.validation_detail ? stringifyJson(fields.validation_detail) : null); }
    if (fields.outcome_detail !== undefined) { sets.push('outcome_detail = ?'); params.push(fields.outcome_detail ? stringifyJson(fields.outcome_detail) : null); }
    if (fields.lifecycle_updated_at !== undefined) { sets.push('lifecycle_updated_at = ?'); params.push(fields.lifecycle_updated_at); }

    params.push(taskId);
    await this.db.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`,
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
    // rejected by the `owner IS NULL OR owner = ?` condition below.
    const limit = options?.maxDoingForTeam;
    const workflow = options?.workflow;
    const workflowSet = workflow
      ? ', assignment_id = ?, delegation_lineage = ?'
      : '';
    const workflowParams = workflow
      ? [workflow.assignmentId, stringifyJson(workflow.lineage)]
      : [];
    if (limit !== undefined) {
      const { rowCount } = await this.db.query(
        `UPDATE tasks
         SET owner = ?, status = 'doing', updated_at = ?, workflow_state = 'executing',
             blocked_detail = NULL, lifecycle_updated_at = ?${workflowSet}
         WHERE id = ? AND (owner IS NULL OR owner = ?) AND status = 'todo'
           AND (
             SELECT COUNT(*)
             FROM tasks active
             WHERE active.status = 'doing'
               AND (
                 active.team_id = tasks.team_id
                 OR (active.team_id IS NULL AND tasks.team_id IS NULL)
               )
           ) < ?`,
        [ownerId, updatedAt, updatedAt, ...workflowParams, taskId, ownerId, limit],
      );
      return rowCount > 0;
    }

    const { rowCount } = await this.db.query(
      `UPDATE tasks
       SET owner = ?, status = 'doing', updated_at = ?, workflow_state = 'executing',
           blocked_detail = NULL, lifecycle_updated_at = ?${workflowSet}
       WHERE id = ? AND (owner IS NULL OR owner = ?) AND status = 'todo'`,
      [ownerId, updatedAt, updatedAt, ...workflowParams, taskId, ownerId],
    );
    return rowCount > 0;
  }

  async releaseClaim(
    taskId: string,
    ownerId: string,
    claimedAt: number,
    updatedAt: number,
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE tasks
       SET owner = NULL, status = 'todo', completed_at = NULL,
           workflow_state = 'queued', assignment_id = NULL, lifecycle_updated_at = ?, updated_at = ?
       WHERE id = ? AND owner = ? AND status = 'doing' AND updated_at = ?`,
      [updatedAt, updatedAt, taskId, ownerId, claimedAt],
    );
    return rowCount > 0;
  }

  async delete(taskId: string): Promise<void> {
    await this.db.query(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }

  async replaceEventLinks(taskId: string, scheduleIds: string[]): Promise<void> {
    await this.db.query(
      `DELETE FROM task_event_links WHERE task_id = ?`,
      [taskId],
    );
    const now = Math.floor(Date.now() / 1000);
    for (const scheduleId of scheduleIds) {
      await this.db.query(
        `INSERT INTO task_event_links (task_id, schedule_id, created_at) VALUES (?, ?, ?)`,
        [taskId, scheduleId, now],
      );
    }
  }

  async listEventLinksForTask(taskId: string): Promise<Array<{ schedule_id: string }>> {
    const { rows } = await this.db.query<{ schedule_id: string }>(
      `SELECT schedule_id FROM task_event_links WHERE task_id = ?`,
      [taskId],
    );
    return rows;
  }

  async listTasksForSchedule(scheduleId: string): Promise<TaskRow[]> {
    const { rows } = await this.db.query<TaskRow>(
      `SELECT t.* FROM tasks t
       JOIN task_event_links tel ON tel.task_id = t.id
       WHERE tel.schedule_id = ?
       ORDER BY t.updated_at DESC`,
      [scheduleId],
    );
    return rows.map(taskRow);
  }
}
