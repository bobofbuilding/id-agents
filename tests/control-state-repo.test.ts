import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../src/db/migrations/sqlite.js';
import { SqliteControlStateRepo } from '../src/db/repos/sqlite/control-state-repo.js';
import { SqliteTasksRepo } from '../src/db/repos/sqlite/tasks-repo.js';

describe('manager control state and task lineage', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await migrateSqlite(adapter);
    await adapter.query(
      `INSERT INTO teams(id,name,config,port_start,port_end) VALUES(?,?,?,?,?)`,
      ['team-1', 'default', '{}', 4101, 4125],
    );
  });
  afterEach(async () => { await adapter.close(); });

  it('persists versioned state and rejects stale optimistic writes', async () => {
    const repo = new SqliteControlStateRepo(adapter);
    const first = await repo.upsert({ teamId: 'team-1', scope: 'project', key: 'alpha', value: { name: 'Alpha' }, now: 10 });
    expect(first?.version).toBe(1);
    expect((await repo.get('team-1', 'project', 'alpha'))?.value).toEqual({ name: 'Alpha' });
    const unchanged = await repo.upsert({ teamId: 'team-1', scope: 'project', key: 'alpha', value: { name: 'Alpha' }, now: 11 });
    expect(unchanged).toMatchObject({ version: 1, updated_at: 10 });
    expect(await repo.upsert({ teamId: 'team-1', scope: 'project', key: 'alpha', value: { name: 'stale' }, expectedVersion: 0, now: 11 })).toBeNull();
    const second = await repo.upsert({ teamId: 'team-1', scope: 'project', key: 'alpha', value: { name: 'Alpha 2' }, expectedVersion: 1, now: 12 });
    expect(second?.version).toBe(2);
    const concurrent = await Promise.all([
      repo.upsert({ teamId: 'team-1', scope: 'project', key: 'alpha', value: { name: 'Winner A' }, expectedVersion: 2, now: 13 }),
      repo.upsert({ teamId: 'team-1', scope: 'project', key: 'alpha', value: { name: 'Winner B' }, expectedVersion: 2, now: 13 }),
    ]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    expect((await repo.get('team-1', 'project', 'alpha'))?.version).toBe(3);
    expect(await repo.delete('team-1', 'project', 'alpha')).toBe(true);
  });

  it('stores project and plan lineage on task rows', async () => {
    const repo = new SqliteTasksRepo(adapter);
    await repo.create({
      id: 'task-1', name: 'build-alpha', uuid: '00000000-0000-4000-8000-000000000001', team_id: 'team-1',
      title: 'Build Alpha', description: null, status: 'todo', created_by: null, owner: null,
      created_at: 10, updated_at: 10, completed_at: null, project_id: 'alpha', plan_id: '70',
    });
    const task = await repo.getByNameForTeam('build-alpha', 'team-1');
    expect(task).toMatchObject({ project_id: 'alpha', plan_id: '70' });
  });
});
