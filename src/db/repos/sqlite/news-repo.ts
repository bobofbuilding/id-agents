// SPDX-License-Identifier: MIT

import type { NewsRepository } from '../../db-service.js';
import type { InboxOwnerKind, NewsItemRow, NewsItemSummaryRow } from '../../types.js';
import type { DbAdapter } from '../../db-adapter.js';
import { parseJsonObject, stringifyJson } from '../../db-json.js';

const RETENTION_DELETE_BATCH = 500;

function resolveNewsOwnership(
  teamId: string,
  agentId: string | null,
  item: { owner_kind?: InboxOwnerKind; owner_id?: string },
): { owner_kind: InboxOwnerKind; owner_id: string } {
  if (item.owner_kind != null && item.owner_id != null) {
    return { owner_kind: item.owner_kind, owner_id: item.owner_id };
  }
  if (agentId != null && agentId !== '') {
    if (agentId.startsWith('manager-')) {
      return { owner_kind: 'manager', owner_id: teamId };
    }
    return { owner_kind: 'agent', owner_id: agentId };
  }
  throw new Error('SqliteNewsRepo: owner_kind/owner_id required when agentId is null');
}

export class SqliteNewsRepo implements NewsRepository {
  constructor(private readonly db: DbAdapter) {}

  private parseNewsRow(row: any): NewsItemRow | null {
    if (!row) return null;
    const agent_id =
      row.agent_id != null && row.agent_id !== ''
        ? String(row.agent_id)
        : null;
    const team_id = String(row.team_id ?? '');
    const owner_kind: InboxOwnerKind =
      row.owner_kind === 'manager' || row.owner_kind === 'agent'
        ? row.owner_kind
        : agent_id?.startsWith('manager-')
          ? 'manager'
          : 'agent';
    const owner_id =
      row.owner_id != null && String(row.owner_id) !== ''
        ? String(row.owner_id)
        : owner_kind === 'manager'
          ? team_id
          : agent_id ?? '';
    return {
      ...row,
      team_id,
      agent_id,
      owner_kind,
      owner_id,
      data: parseJsonObject(row.data),
    };
  }

  private parseSummaryRow(row: any): NewsItemSummaryRow | null {
    if (!row) return null;
    const agent_id =
      row.agent_id != null && row.agent_id !== ''
        ? String(row.agent_id)
        : null;
    const team_id = String(row.team_id ?? '');
    const owner_kind: InboxOwnerKind =
      row.owner_kind === 'manager' || row.owner_kind === 'agent'
        ? row.owner_kind
        : agent_id?.startsWith('manager-')
          ? 'manager'
          : 'agent';
    const owner_id =
      row.owner_id != null && String(row.owner_id) !== ''
        ? String(row.owner_id)
        : owner_kind === 'manager'
          ? team_id
          : agent_id ?? '';
    return {
      id: Number(row.id),
      team_id,
      agent_id,
      timestamp: Number(row.timestamp),
      type: String(row.type ?? ''),
      message: row.message == null ? null : String(row.message),
      message_length: Number(row.message_length ?? 0),
      has_data: row.has_data === true || row.has_data === 1,
      data_length: Number(row.data_length ?? 0),
      query_id: row.query_id == null ? null : String(row.query_id),
      kind: row.kind === 'talk' || row.kind === 'notify' ? row.kind : null,
      reply_expected: row.reply_expected == null ? null : row.reply_expected === true || row.reply_expected === 1,
      owner_kind,
      owner_id,
    };
  }

  async add(
    teamId: string,
    agentId: string | null,
    item: {
      timestamp: number;
      type: string;
      message?: string;
      data?: Record<string, unknown>;
      query_id?: string;
      kind?: 'talk' | 'notify';
      reply_expected?: boolean;
      owner_kind?: InboxOwnerKind;
      owner_id?: string;
    },
  ): Promise<void> {
    const replyExpected =
      item.reply_expected !== undefined
        ? item.reply_expected
        : item.kind === 'talk'
          ? true
          : item.kind === 'notify'
            ? false
            : null;
    const own = resolveNewsOwnership(teamId, agentId, item);
    await this.db.query(
      `INSERT INTO news_items (team_id, agent_id, timestamp, type, message, data, query_id, kind, reply_expected, owner_kind, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        teamId,
        agentId,
        item.timestamp,
        item.type,
        item.message ?? null,
        item.data ? stringifyJson(item.data) : null,
        item.query_id ?? null,
        item.kind ?? null,
        replyExpected === null ? null : replyExpected ? 1 : 0,
        own.owner_kind,
        own.owner_id,
      ],
    );
  }

  async poll(
    agentId: string,
    since: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    let sql =
      'SELECT id, team_id, agent_id, type, timestamp, message, data, query_id, kind, reply_expected, owner_kind, owner_id FROM news_items WHERE agent_id = ? AND timestamp > ?';
    const params: unknown[] = [agentId, since];

    if (opts?.queryId) {
      sql += ' AND query_id = ?';
      params.push(opts.queryId);
    }

    sql += ' ORDER BY timestamp DESC';

    const limit = opts?.limit ?? 1000;
    sql += ' LIMIT ?';
    params.push(limit);

    const r = await this.db.query<NewsItemRow>(sql, params);
    return r.rows.map((row) => this.parseNewsRow(row)!);
  }

  async pollSummary(
    agentId: string,
    since: number,
    opts?: { limit?: number; queryId?: string; messagePreviewChars?: number },
  ): Promise<NewsItemSummaryRow[]> {
    const previewChars = Math.min(Math.max(Math.floor(opts?.messagePreviewChars ?? 160), 0), 1000);
    let sql =
      `SELECT id, team_id, agent_id, type, timestamp,
              CASE WHEN message IS NULL THEN NULL ELSE substr(message, 1, ?) END AS message,
              COALESCE(length(message), 0) AS message_length,
              CASE WHEN data IS NULL THEN 0 ELSE 1 END AS has_data,
              COALESCE(length(data), 0) AS data_length,
              query_id, kind, reply_expected, owner_kind, owner_id
       FROM news_items
       WHERE agent_id = ? AND timestamp > ?`;
    const params: unknown[] = [previewChars, agentId, since];

    if (opts?.queryId) {
      sql += ' AND query_id = ?';
      params.push(opts.queryId);
    }

    sql += ' ORDER BY timestamp DESC';

    const limit = opts?.limit ?? 1000;
    sql += ' LIMIT ?';
    params.push(limit);

    const r = await this.db.query<NewsItemSummaryRow>(sql, params);
    return r.rows.map((row) => this.parseSummaryRow(row)!);
  }

  async pollByOwner(
    teamId: string,
    ownerKind: InboxOwnerKind,
    ownerId: string,
    since: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    let sql =
      'SELECT id, team_id, agent_id, type, timestamp, message, data, query_id, kind, reply_expected, owner_kind, owner_id FROM news_items WHERE team_id = ? AND owner_kind = ? AND owner_id = ? AND timestamp > ?';
    const params: unknown[] = [teamId, ownerKind, ownerId, since];

    if (opts?.queryId) {
      sql += ' AND query_id = ?';
      params.push(opts.queryId);
    }

    sql += ' ORDER BY timestamp DESC';

    const limit = opts?.limit ?? 1000;
    sql += ' LIMIT ?';
    params.push(limit);

    const r = await this.db.query<NewsItemRow>(sql, params);
    return r.rows.map((row) => this.parseNewsRow(row)!);
  }

  async pollSinceId(
    agentId: string,
    sinceId: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    let sql =
      'SELECT id, team_id, agent_id, type, timestamp, message, data, query_id, kind, reply_expected, owner_kind, owner_id FROM news_items WHERE agent_id = ? AND id > ?';
    const params: unknown[] = [agentId, sinceId];

    if (opts?.queryId) {
      sql += ' AND query_id = ?';
      params.push(opts.queryId);
    }

    sql += ' ORDER BY id ASC';

    const limit = opts?.limit ?? 1000;
    sql += ' LIMIT ?';
    params.push(limit);

    const r = await this.db.query<NewsItemRow>(sql, params);
    return r.rows.map((row) => this.parseNewsRow(row)!);
  }

  async pollSinceIdByOwner(
    teamId: string,
    ownerKind: InboxOwnerKind,
    ownerId: string,
    sinceId: number,
    opts?: { limit?: number; queryId?: string },
  ): Promise<NewsItemRow[]> {
    let sql =
      'SELECT id, team_id, agent_id, type, timestamp, message, data, query_id, kind, reply_expected, owner_kind, owner_id FROM news_items WHERE team_id = ? AND owner_kind = ? AND owner_id = ? AND id > ?';
    const params: unknown[] = [teamId, ownerKind, ownerId, sinceId];

    if (opts?.queryId) {
      sql += ' AND query_id = ?';
      params.push(opts.queryId);
    }

    sql += ' ORDER BY id ASC';

    const limit = opts?.limit ?? 1000;
    sql += ' LIMIT ?';
    params.push(limit);

    const r = await this.db.query<NewsItemRow>(sql, params);
    return r.rows.map((row) => this.parseNewsRow(row)!);
  }

  async getRecent(teamId: string, types: string[], limit: number): Promise<NewsItemRow[]> {
    const placeholders = types.map(() => '?').join(', ');
    const r = await this.db.query<NewsItemRow>(
      `SELECT id, team_id, agent_id, query_id, type, message, timestamp, data, kind, reply_expected, owner_kind, owner_id
       FROM news_items
       WHERE team_id = ? AND type IN (${placeholders})
       ORDER BY timestamp DESC
       LIMIT ?`,
      [teamId, ...types, limit],
    );
    return r.rows.map((row) => this.parseNewsRow(row)!);
  }

  async fetchForArchive(teamId: string, before: number): Promise<NewsItemRow[]> {
    const r = await this.db.query<NewsItemRow>(
      `SELECT id, type, timestamp, message, data, team_id, agent_id, query_id, kind, reply_expected, owner_kind, owner_id
       FROM news_items
       WHERE team_id = ? AND timestamp < ?
       ORDER BY timestamp ASC`,
      [teamId, before],
    );
    return r.rows.map((row) => this.parseNewsRow(row)!);
  }

  async deleteArchived(teamId: string, before: number): Promise<void> {
    await this.db.query(
      'DELETE FROM news_items WHERE team_id = ? AND timestamp < ?',
      [teamId, before],
    );
  }

  async pruneByAge(teamId: string, beforeTimestamp: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM news_items
       WHERE team_id = ?
         AND id IN (
           SELECT id FROM news_items
           WHERE team_id = ? AND timestamp < ?
           ORDER BY timestamp ASC, id ASC
           LIMIT ?
         )`,
      [teamId, teamId, beforeTimestamp, RETENTION_DELETE_BATCH],
    );
    return rowCount ?? 0;
  }

  async pruneByCount(teamId: string, keepCount: number): Promise<number> {
    if (keepCount < 0) keepCount = 0;
    const total = await this.countForTeam(teamId);
    const excess = total - keepCount;
    if (excess <= 0) return 0;
    const deleteCount = Math.min(excess, RETENTION_DELETE_BATCH);
    const { rowCount } = await this.db.query(
      `DELETE FROM news_items
       WHERE team_id = ?
         AND id IN (
           SELECT id FROM news_items
           WHERE team_id = ?
           ORDER BY timestamp ASC, id ASC
           LIMIT ?
         )`,
      [teamId, teamId, deleteCount],
    );
    return rowCount ?? 0;
  }

  async countForTeam(teamId: string): Promise<number> {
    const { rows } = await this.db.query<{ c: number | string }>(
      'SELECT COUNT(*) AS c FROM news_items WHERE team_id = ?',
      [teamId],
    );
    return Number(rows[0]?.c ?? 0);
  }
}
