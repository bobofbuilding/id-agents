// SPDX-License-Identifier: MIT
/**
 * Renderer-neutral, injectable manager API client.
 *
 * Every dependency the client needs to reach the manager — the base URL and
 * the `fetch` implementation — is injected, so the same client drives the TUI
 * (real `globalThis.fetch`), the Electron main process (Node `fetch`), and unit
 * tests (a stub). No process/env/DOM access lives here.
 *
 * All `/remote` proxy calls funnel through a single consolidated request path
 * (`remote()`), which is also where transport errors are classified:
 *   - NetworkError — couldn't reach the manager, or the manager returned 5xx.
 *   - ManagerError — the manager understood and rejected (4xx, an
 *     `{ ok:false, error }` envelope, or a structurally malformed response that
 *     fails boundary validation in `./validation.ts`).
 */

import { ManagerError, NetworkError } from './errors.js';
import type {
  Agent,
  InstallLibraryTeamRequest,
  InstallLibraryTeamResponse,
  LibraryAgentDetailResponse,
  LibraryAgentListResponse,
  LibrarySkillDetailResponse,
  LibrarySkillListResponse,
  LibraryTeamDetailResponse,
  LibraryTeamListResponse,
  NewsItem,
  Schedule,
  Task,
  Team,
} from './types.js';
import {
  parseAgentsResponse,
  parseLibraryAgentDetail,
  parseLibraryAgentList,
  parseLibrarySkillDetail,
  parseLibrarySkillList,
  parseLibraryTeamDetail,
  parseLibraryTeamList,
  parseInstallSuccess,
  parseNewsResult,
  parseRemoteEnvelope,
  parseScheduleResult,
  parseTaskResult,
  parseTeamsResponse,
  withTeamName,
} from './validation.js';

// Re-export the transport error taxonomy so existing importers of the client
// module keep resolving `NetworkError` / `ManagerError`.
export { NetworkError, ManagerError } from './errors.js';

/**
 * The subset of the WHATWG `fetch` surface the client relies on. Kept narrow so
 * a Node/undici fetch, the browser fetch, or a test stub all satisfy it.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface ManagerClientOptions {
  /** Base URL of the manager, e.g. `http://localhost:4100`. */
  baseUrl: string;
  /**
   * Injected fetch. Defaults to a late-bound wrapper over `globalThis.fetch`
   * so callers (and tests that stub `globalThis.fetch`) work without wiring.
   */
  fetch?: FetchLike;
}

export class ManagerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: ManagerClientOptions) {
    this.baseUrl = options.baseUrl;
    // Late-bind globalThis.fetch so a test that reassigns it after
    // construction is still honored (mirrors the historical free functions).
    this.fetchImpl =
      options.fetch ??
      ((url, init) => (globalThis.fetch as unknown as FetchLike)(url, init));
  }

  /* ---------------- transport primitives ---------------- */

  private async getJson<T>(path: string, signal: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, { signal });
    if (!res.ok) {
      throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  /**
   * The single consolidated `/remote` request path. Every command-style call
   * (runRemoteCommand, tasks, news, schedules) routes through here so error
   * classification and the request envelope live in exactly one place.
   */
  private async remote<T>(
    executor: string,
    command: string,
    signal: AbortSignal,
    teamName?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (teamName) headers['x-id-team'] = teamName;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/remote`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ agent: executor, command }),
        signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new NetworkError(msg);
    }
    if (!res.ok) {
      if (res.status >= 500) {
        throw new NetworkError(`POST /remote → ${res.status} ${res.statusText}`);
      }
      throw new ManagerError(`POST /remote → ${res.status} ${res.statusText}`);
    }
    const data = parseRemoteEnvelope<T>(await res.json());
    if (!data.ok) {
      throw new ManagerError(data.error ?? 'unknown manager error');
    }
    return data.result as T;
  }

  /** Public escape hatch for arbitrary approved commands via `/remote`. */
  runRemoteCommand<T = unknown>(
    executor: string,
    command: string,
    signal: AbortSignal,
    teamName?: string,
  ): Promise<T> {
    return this.remote<T>(executor, command, signal, teamName);
  }

  /* ---------------- teams / agents ---------------- */

  async fetchTeams(signal: AbortSignal): Promise<Team[]> {
    const data = await this.getJson<unknown>('/teams', signal);
    return parseTeamsResponse(data).filter((t) => t.name.toLowerCase() !== 'all');
  }

  async fetchAgentsByTeam(team: string, signal: AbortSignal): Promise<Agent[]> {
    const data = await this.getJson<unknown>(`/agents?team=${encodeURIComponent(team)}`, signal);
    return parseAgentsResponse(data).map((a) => ({ ...a, teamName: team }));
  }

  async fetchAgentsAllTeams(teams: Team[], signal: AbortSignal): Promise<Agent[]> {
    if (teams.length === 0) return [];
    const results = await Promise.all(teams.map((t) => this.fetchAgentsByTeam(t.name, signal)));
    const merged = new Map<string, Agent>();
    for (const list of results) {
      for (const agent of list) {
        if (!merged.has(agent.id)) merged.set(agent.id, agent);
      }
    }
    return [...merged.values()];
  }

  /* ---------------- tasks ---------------- */

  async fetchTasks(executor: string, signal: AbortSignal, teamName?: string): Promise<Task[]> {
    const result = await this.remote<unknown>(executor, '/task', signal, teamName);
    return parseTaskResult(result);
  }

  async fetchTasksAllTeams(executor: string, teams: Team[], signal: AbortSignal): Promise<Task[]> {
    if (teams.length === 0) return [];
    const results = await Promise.all(teams.map((t) => this.fetchTasks(executor, signal, t.name)));
    return results.flat();
  }

  /* ---------------- news ---------------- */

  async fetchAgentNews(
    executor: string,
    target: string,
    signal: AbortSignal,
    teamName?: string,
  ): Promise<NewsItem[]> {
    const result = await this.remote<unknown>(executor, `/news ${target}`, signal, teamName);
    return parseNewsResult(result);
  }

  async fetchLatestNewsTs(
    executor: string,
    targetName: string,
    signal: AbortSignal,
    teamName?: string,
  ): Promise<number | null> {
    const items = await this.fetchAgentNews(executor, targetName, signal, teamName);
    if (items.length === 0) return null;
    let max = 0;
    for (const it of items) if (it.timestamp > max) max = it.timestamp;
    return max > 0 ? max : null;
  }

  async fetchAgentsLatestNewsTs(
    executor: string,
    agents: Agent[],
    signal: AbortSignal,
  ): Promise<Map<string, number | null>> {
    if (agents.length === 0) return new Map();
    const results = await Promise.all(
      agents.map(async (a) => {
        try {
          const ts = await this.fetchLatestNewsTs(executor, a.name, signal, a.teamName);
          return [a.id, ts] as const;
        } catch {
          return [a.id, null] as const;
        }
      }),
    );
    return new Map(results);
  }

  /* ---------------- schedules ---------------- */

  async fetchSchedulesForTeam(
    executor: string,
    teamName: string,
    signal: AbortSignal,
  ): Promise<Schedule[]> {
    const result = await this.remote<unknown>(executor, '/schedule list', signal, teamName);
    return withTeamName(parseScheduleResult(result), teamName);
  }

  async fetchSchedulesAllTeams(
    executor: string,
    teams: Team[],
    signal: AbortSignal,
  ): Promise<Schedule[]> {
    if (teams.length === 0) return [];
    const results = await Promise.all(
      teams.map((t) => this.fetchSchedulesForTeam(executor, t.name, signal)),
    );
    const merged = new Map<string, Schedule>();
    for (const list of results) {
      for (const s of list) {
        if (!merged.has(s.id)) merged.set(s.id, s);
      }
    }
    return [...merged.values()];
  }

  /* ---------------- library inventory ---------------- */

  async fetchLibraryAgents(signal: AbortSignal): Promise<LibraryAgentListResponse> {
    return parseLibraryAgentList(await this.getJson<unknown>('/library/agents', signal));
  }

  async fetchLibraryAgent(
    name: string,
    signal: AbortSignal,
  ): Promise<LibraryAgentDetailResponse | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/library/agents/${encodeURIComponent(name)}`, {
      signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GET /library/agents/${name} → ${res.status} ${res.statusText}`);
    }
    return parseLibraryAgentDetail(await res.json());
  }

  async fetchLibrarySkills(signal: AbortSignal): Promise<LibrarySkillListResponse> {
    return parseLibrarySkillList(await this.getJson<unknown>('/library/skills', signal));
  }

  async fetchLibrarySkill(
    name: string,
    signal: AbortSignal,
  ): Promise<LibrarySkillDetailResponse | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/library/skills/${encodeURIComponent(name)}`, {
      signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GET /library/skills/${name} → ${res.status} ${res.statusText}`);
    }
    return parseLibrarySkillDetail(await res.json());
  }

  async fetchLibraryTeams(signal: AbortSignal): Promise<LibraryTeamListResponse> {
    return parseLibraryTeamList(await this.getJson<unknown>('/library/teams', signal));
  }

  async fetchLibraryTeam(
    name: string,
    signal: AbortSignal,
  ): Promise<LibraryTeamDetailResponse | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/library/teams/${encodeURIComponent(name)}`, {
      signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GET /library/teams/${name} → ${res.status} ${res.statusText}`);
    }
    return parseLibraryTeamDetail(await res.json());
  }

  // POST /library/install — wraps the backend selector grammar
  // (from: "team:<template>", to: "team:<dest>") behind a typed helper.
  // Returns a normalized success/failure so callers don't rebuild the
  // `team:` envelope at every site.
  async installLibraryTeam(
    req: InstallLibraryTeamRequest,
    signal: AbortSignal,
  ): Promise<InstallLibraryTeamResponse> {
    const body = {
      from: `team:${req.template}`,
      to: `team:${req.dest}`,
      force: req.force === true,
    };
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/library/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new NetworkError(msg);
    }
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { error: text || res.statusText };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`,
        ...parsed,
      };
    }
    return parseInstallSuccess(parsed);
  }
}
