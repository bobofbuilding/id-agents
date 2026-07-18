// SPDX-License-Identifier: MIT
/**
 * Boundary-validation characterization for the dashboard-core ManagerClient.
 *
 * The manager is a separate process, so its JSON is untrusted. These tests
 * drive the client with an injected `fetch` returning malformed payloads and
 * assert the contract:
 *   - valid payloads pass through unchanged (historical behavior preserved);
 *   - a required field that is missing OR wrong-typed → typed `ManagerError`;
 *   - an optional field that is present but wrong-typed → typed `ManagerError`;
 *   - identity-only rows (name/id only) that valid callers legitimately send
 *     still pass.
 */

import { describe, expect, it } from 'vitest';
import { ManagerClient, ManagerError } from '../../src/dashboard-core/api/client.js';
import type { FetchLike } from '../../src/dashboard-core/api/client.js';

const signal = new AbortController().signal;

/** Build a client whose injected fetch returns `body` for every request. */
function clientReturning(body: unknown, opts: { ok?: boolean; status?: number } = {}): ManagerClient {
  const { ok = true, status = 200 } = opts;
  const fetchImpl: FetchLike = async () => ({
    ok,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  return new ManagerClient({ baseUrl: 'http://manager.test', fetch: fetchImpl });
}

const VALID_AGENT = {
  id: 'a1',
  name: 'seniordev',
  port: 4290,
  status: 'running',
  health: 'online',
  createdAt: 1_700_000_000_000,
  model: 'claude-fable-5',
  metadata: { runtime: 'claude-code-cli' },
};

describe('ManagerClient boundary validation — teams', () => {
  it('accepts a well-formed teams payload and filters "all"', async () => {
    const c = clientReturning({
      teams: [
        { id: 't1', name: 'idchain', agentCount: 2 },
        { id: 't2', name: 'all', agentCount: 0 },
      ],
    });
    expect((await c.fetchTeams(signal)).map((t) => t.name)).toEqual(['idchain']);
  });

  it('accepts identity-only team rows (name only)', async () => {
    const c = clientReturning({ teams: [{ name: 'idchain' }, { name: 'public' }] });
    expect((await c.fetchTeams(signal)).map((t) => t.name)).toEqual(['idchain', 'public']);
  });

  it('treats a missing teams key as empty', async () => {
    await expect(clientReturning({}).fetchTeams(signal)).resolves.toEqual([]);
  });

  it('rejects a row missing name with ManagerError', async () => {
    await expect(clientReturning({ teams: [{}] }).fetchTeams(signal)).rejects.toBeInstanceOf(ManagerError);
  });

  it('rejects a non-array teams field with ManagerError', async () => {
    await expect(clientReturning({ teams: 'nope' }).fetchTeams(signal)).rejects.toBeInstanceOf(ManagerError);
  });

  it('rejects a wrong-typed optional agentCount with ManagerError', async () => {
    const c = clientReturning({ teams: [{ name: 'idchain', agentCount: 'two' }] });
    await expect(c.fetchTeams(signal)).rejects.toBeInstanceOf(ManagerError);
  });
});

describe('ManagerClient boundary validation — agents', () => {
  it('accepts a fully-populated agent', async () => {
    const c = clientReturning({ agents: [VALID_AGENT] });
    const agents = await c.fetchAgentsByTeam('idchain', signal);
    expect(agents[0]!.teamName).toBe('idchain');
    expect(agents[0]!.health).toBe('online');
  });

  it('accepts an identity-only agent row (id + name)', async () => {
    const c = clientReturning({ agents: [{ id: 'a1', name: 'cto' }] });
    await expect(c.fetchAgentsByTeam('idchain', signal)).resolves.toHaveLength(1);
  });

  it('rejects an agent row without id/name', async () => {
    await expect(
      clientReturning({ agents: [{ status: 'running' }] }).fetchAgentsByTeam('idchain', signal),
    ).rejects.toBeInstanceOf(ManagerError);
  });

  it('rejects a wrong-typed required field (port as string)', async () => {
    const c = clientReturning({ agents: [{ ...VALID_AGENT, port: '4290' }] });
    await expect(c.fetchAgentsByTeam('idchain', signal)).rejects.toBeInstanceOf(ManagerError);
  });

  it('rejects a wrong-typed optional metadata (array, not object)', async () => {
    const c = clientReturning({ agents: [{ id: 'a', name: 'x', metadata: [] }] });
    await expect(c.fetchAgentsByTeam('idchain', signal)).rejects.toBeInstanceOf(ManagerError);
  });

  it('rejects a wrong-typed nullable field (last_seen as string)', async () => {
    const c = clientReturning({ agents: [{ id: 'a', name: 'x', last_seen: 'yesterday' }] });
    await expect(c.fetchAgentsByTeam('idchain', signal)).rejects.toBeInstanceOf(ManagerError);
  });

  it('preserves profile bio/handles inside metadata (typed on AgentMetadata)', async () => {
    const c = clientReturning({
      agents: [{
        id: 'a1',
        name: 'dev',
        metadata: { bio: 'Builds the dashboard.', handles: { x: '@dev', github: 'dev-gh' } },
      }],
    });
    const [agent] = await c.fetchAgentsByTeam('idchain', signal);
    expect(agent!.metadata?.bio).toBe('Builds the dashboard.');
    expect(agent!.metadata?.handles).toEqual({ x: '@dev', github: 'dev-gh' });
  });

  it('accepts explicit null for nullable fields (remote-endpoint agents)', async () => {
    // Live remote-endpoint agents carry port/url/workingDirectory/pid as null.
    const c = clientReturning({
      agents: [{ id: 'a', name: 'x', last_seen: null, pid: null, port: null, url: null, workingDirectory: null }],
    });
    await expect(c.fetchAgentsByTeam('idchain', signal)).resolves.toHaveLength(1);
  });
});

describe('ManagerClient boundary validation — /remote lists', () => {
  it('accepts a well-formed task result', async () => {
    const c = clientReturning({
      ok: true,
      result: { tasks: [{ name: 't', title: 'T', status: 'todo', createdAt: 1 }] },
    });
    expect((await c.fetchTasks('coder', signal, 'idchain')).map((t) => t.name)).toEqual(['t']);
  });

  it('treats an ok result with no tasks key as empty', async () => {
    await expect(clientReturning({ ok: true, result: {} }).fetchTasks('coder', signal)).resolves.toEqual([]);
  });

  it('rejects a task row missing required createdAt', async () => {
    const c = clientReturning({ ok: true, result: { tasks: [{ name: 't', title: 'T', status: 'todo' }] } });
    await expect(c.fetchTasks('coder', signal)).rejects.toBeInstanceOf(ManagerError);
  });

  it('rejects a task with wrong-typed optional completedAt', async () => {
    const c = clientReturning({
      ok: true,
      result: { tasks: [{ name: 't', title: 'T', status: 'todo', createdAt: 1, completedAt: 'soon' }] },
    });
    await expect(c.fetchTasks('coder', signal)).rejects.toBeInstanceOf(ManagerError);
  });

  it('rejects a malformed news item (non-numeric timestamp)', async () => {
    const c = clientReturning({ ok: true, result: { items: [{ type: 'x', timestamp: 'soon' }] } });
    await expect(c.fetchAgentNews('coder', 'x', signal)).rejects.toBeInstanceOf(ManagerError);
  });

  it('accepts a well-formed schedule and rejects a missing required field', async () => {
    const good = {
      id: 's',
      title: 'hb',
      kind: 'heartbeat',
      active: true,
      targets: ['coder'],
      intervalSeconds: 3600,
      timezone: null,
      localTimeSeconds: null,
      localDate: null,
      daysOfWeek: null,
      createdAt: 1,
    };
    await expect(
      clientReturning({ ok: true, result: { schedules: [good] } }).fetchSchedulesForTeam('coder', 'idchain', signal),
    ).resolves.toHaveLength(1);

    const { active: _omit, ...missingActive } = good;
    await expect(
      clientReturning({ ok: true, result: { schedules: [missingActive] } }).fetchSchedulesForTeam('coder', 'idchain', signal),
    ).rejects.toBeInstanceOf(ManagerError);
  });

  it('rejects a schedule whose targets are not an array of strings', async () => {
    const c = clientReturning({
      ok: true,
      result: {
        schedules: [
          {
            id: 's',
            title: 'hb',
            kind: 'heartbeat',
            active: true,
            targets: [1, 2],
            intervalSeconds: null,
            timezone: null,
            localTimeSeconds: null,
            localDate: null,
            daysOfWeek: null,
            createdAt: 1,
          },
        ],
      },
    });
    await expect(c.fetchSchedulesForTeam('coder', 'idchain', signal)).rejects.toBeInstanceOf(ManagerError);
  });

  it('surfaces a non-object /remote body as ManagerError (malformed envelope)', async () => {
    await expect(clientReturning('not-json-object').fetchTasks('coder', signal)).rejects.toBeInstanceOf(ManagerError);
  });
});

describe('ManagerClient boundary validation — library', () => {
  const VALID_LIB_AGENT = {
    name: 'devops',
    shape: 'claude-native',
    hasReadme: true,
    hasLicense: false,
    subfolders: ['skills'],
    source_path: '/root/devops',
    description: null,
  };

  it('accepts a well-formed library agents list', async () => {
    const c = clientReturning({ libraryRoot: '/root', entries: [VALID_LIB_AGENT], errors: [] });
    const res = await c.fetchLibraryAgents(signal);
    expect(res.entries.map((e) => e.name)).toEqual(['devops']);
    expect(res.libraryRoot).toBe('/root');
  });

  it('rejects a library list whose entries are not an array', async () => {
    await expect(
      clientReturning({ libraryRoot: null, entries: 'nope' }).fetchLibraryAgents(signal),
    ).rejects.toBeInstanceOf(ManagerError);
  });

  it('rejects a library row with an invalid shape enum', async () => {
    const c = clientReturning({ libraryRoot: null, entries: [{ ...VALID_LIB_AGENT, shape: 'bogus' }], errors: [] });
    await expect(c.fetchLibraryAgents(signal)).rejects.toBeInstanceOf(ManagerError);
  });

  it('rejects a malformed library error row', async () => {
    const c = clientReturning({
      libraryRoot: null,
      entries: [VALID_LIB_AGENT],
      errors: [{ name: 'x', code: 'E', message: 42 }],
    });
    await expect(c.fetchLibraryAgents(signal)).rejects.toBeInstanceOf(ManagerError);
  });

  it('accepts a well-formed library agent detail and rejects a missing detail field', async () => {
    const detail = {
      ...VALID_LIB_AGENT,
      memoryFile: 'MEMORY.md',
      readme: null,
      memory: '',
      bundledSkills: ['catalog'],
    };
    await expect(clientReturning(detail).fetchLibraryAgent('devops', signal)).resolves.toMatchObject({ name: 'devops' });

    const { memory: _omit, ...missing } = detail;
    await expect(clientReturning(missing).fetchLibraryAgent('devops', signal)).rejects.toBeInstanceOf(ManagerError);
  });

  it('returns null for a 404 detail without validating', async () => {
    await expect(
      clientReturning({}, { ok: false, status: 404 }).fetchLibraryAgent('missing', signal),
    ).resolves.toBeNull();
  });
});

describe('ManagerClient boundary validation — install success', () => {
  const OK_INSTALL = {
    ok: true,
    kind: 'team',
    template: 'web',
    dest: 'web2',
    destPath: '/teams/web2',
    overwritten: false,
    declaredTeamBefore: null,
    declaredTeamAfter: 'web2',
  };

  it('accepts a well-formed install success', async () => {
    const res = await clientReturning(OK_INSTALL).installLibraryTeam({ template: 'web', dest: 'web2' }, signal);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.destPath).toBe('/teams/web2');
  });

  it('rejects a success body missing destPath with ManagerError', async () => {
    const { destPath: _omit, ...bad } = OK_INSTALL;
    await expect(
      clientReturning(bad).installLibraryTeam({ template: 'web', dest: 'web2' }, signal),
    ).rejects.toBeInstanceOf(ManagerError);
  });

  it('normalizes an HTTP failure body into a typed failure (no validation crash)', async () => {
    const res = await clientReturning(
      { error: 'exists' },
      { ok: false, status: 409 },
    ).installLibraryTeam({ template: 'web', dest: 'web2' }, signal);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});
