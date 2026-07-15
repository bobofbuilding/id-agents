// SPDX-License-Identifier: MIT
/**
 * Compatibility adapter over the renderer-neutral dashboard-core client.
 *
 * The transport, DTO mapping, validation, and `/remote` consolidation now live
 * in `src/dashboard-core/api/*`. This module preserves the exact free-function
 * surface the TUI has always imported from `./api/manager.js` — same names,
 * same argument order, same behavior — by delegating each call to an injected
 * `ManagerClient`. The client defaults its `fetch` to a late-bound
 * `globalThis.fetch`, so tests that stub `globalThis.fetch` keep working.
 */

import { ManagerClient } from '../../dashboard-core/api/client.js';
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
} from '../../dashboard-core/api/types.js';

// Re-export the transport error classes and every DTO type so existing
// `import { ... } from './api/manager.js'` call sites resolve unchanged.
export { NetworkError, ManagerError, ManagerClient } from '../../dashboard-core/api/client.js';
export * from '../../dashboard-core/api/types.js';

/** Resolve the manager base URL from the environment (TUI default). */
export function getManagerUrl(): string {
  return process.env.MANAGER_URL ?? 'http://localhost:4100';
}

function client(manager: string): ManagerClient {
  return new ManagerClient({ baseUrl: manager });
}

export function runRemoteCommand<T = unknown>(
  manager: string,
  executor: string,
  command: string,
  signal: AbortSignal,
  teamName?: string,
): Promise<T> {
  return client(manager).runRemoteCommand<T>(executor, command, signal, teamName);
}

export function fetchTeams(manager: string, signal: AbortSignal): Promise<Team[]> {
  return client(manager).fetchTeams(signal);
}

export function fetchAgentsByTeam(
  manager: string,
  team: string,
  signal: AbortSignal,
): Promise<Agent[]> {
  return client(manager).fetchAgentsByTeam(team, signal);
}

export function fetchAgentsAllTeams(
  manager: string,
  teams: Team[],
  signal: AbortSignal,
): Promise<Agent[]> {
  return client(manager).fetchAgentsAllTeams(teams, signal);
}

export function fetchTasks(
  manager: string,
  executor: string,
  signal: AbortSignal,
  teamName?: string,
): Promise<Task[]> {
  return client(manager).fetchTasks(executor, signal, teamName);
}

export function fetchTasksAllTeams(
  manager: string,
  executor: string,
  teams: Team[],
  signal: AbortSignal,
): Promise<Task[]> {
  return client(manager).fetchTasksAllTeams(executor, teams, signal);
}

export function fetchAgentNews(
  manager: string,
  executor: string,
  target: string,
  signal: AbortSignal,
  teamName?: string,
): Promise<NewsItem[]> {
  return client(manager).fetchAgentNews(executor, target, signal, teamName);
}

export function fetchLatestNewsTs(
  manager: string,
  executor: string,
  targetName: string,
  signal: AbortSignal,
  teamName?: string,
): Promise<number | null> {
  return client(manager).fetchLatestNewsTs(executor, targetName, signal, teamName);
}

export function fetchAgentsLatestNewsTs(
  manager: string,
  executor: string,
  agents: Agent[],
  signal: AbortSignal,
): Promise<Map<string, number | null>> {
  return client(manager).fetchAgentsLatestNewsTs(executor, agents, signal);
}

export function fetchSchedulesForTeam(
  manager: string,
  executor: string,
  teamName: string,
  signal: AbortSignal,
): Promise<Schedule[]> {
  return client(manager).fetchSchedulesForTeam(executor, teamName, signal);
}

export function fetchSchedulesAllTeams(
  manager: string,
  executor: string,
  teams: Team[],
  signal: AbortSignal,
): Promise<Schedule[]> {
  return client(manager).fetchSchedulesAllTeams(executor, teams, signal);
}

export function fetchLibraryAgents(
  manager: string,
  signal: AbortSignal,
): Promise<LibraryAgentListResponse> {
  return client(manager).fetchLibraryAgents(signal);
}

export function fetchLibraryAgent(
  manager: string,
  name: string,
  signal: AbortSignal,
): Promise<LibraryAgentDetailResponse | null> {
  return client(manager).fetchLibraryAgent(name, signal);
}

export function fetchLibrarySkills(
  manager: string,
  signal: AbortSignal,
): Promise<LibrarySkillListResponse> {
  return client(manager).fetchLibrarySkills(signal);
}

export function fetchLibrarySkill(
  manager: string,
  name: string,
  signal: AbortSignal,
): Promise<LibrarySkillDetailResponse | null> {
  return client(manager).fetchLibrarySkill(name, signal);
}

export function fetchLibraryTeams(
  manager: string,
  signal: AbortSignal,
): Promise<LibraryTeamListResponse> {
  return client(manager).fetchLibraryTeams(signal);
}

export function fetchLibraryTeam(
  manager: string,
  name: string,
  signal: AbortSignal,
): Promise<LibraryTeamDetailResponse | null> {
  return client(manager).fetchLibraryTeam(name, signal);
}

export function installLibraryTeam(
  manager: string,
  req: InstallLibraryTeamRequest,
  signal: AbortSignal,
): Promise<InstallLibraryTeamResponse> {
  return client(manager).installLibraryTeam(req, signal);
}
