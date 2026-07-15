// SPDX-License-Identifier: MIT
/**
 * Pure agent/team selection + normalization seams shared by the TUI and the
 * Electron dashboard. No Ink or React — these are the derivations the renderer
 * memoizes over.
 */

import type { Agent, Team } from '../api/types.js';

/**
 * Order teams for the team strip: `public` first (a stable anchor right after
 * the synthetic "All" chip), then the remaining teams in manager order.
 */
export function orderTeams(teams: Team[]): Team[] {
  const pub = teams.filter((t) => t.name === 'public');
  const rest = teams.filter((t) => t.name !== 'public');
  return [...pub, ...rest];
}

/** Agents in the selected team, or every agent when no team is selected. */
export function filterAgentsByTeam(agents: Agent[], selectedTeam: string | null): Agent[] {
  return selectedTeam === null ? agents : agents.filter((a) => a.teamName === selectedTeam);
}

/**
 * True when an agent is a remote endpoint (no local process / RSS). Matches on
 * either the explicit deployment shape or the remote runtime marker.
 */
export function isRemoteAgent(agent: Agent): boolean {
  return (
    agent.deploymentShape === 'remote-endpoint' ||
    agent.metadata?.runtime === 'public-agent-remote'
  );
}

/** Set of local (non-remote) agent ids — e.g. the ones that contribute memory. */
export function localAgentIds(agents: Agent[]): Set<string> {
  const s = new Set<string>();
  for (const a of agents) {
    if (!isRemoteAgent(a)) s.add(a.id);
  }
  return s;
}

/**
 * Count rows per team name, skipping rows without a team. Renderer-neutral and
 * generic over anything team-scoped (agents, tasks, …) so agent and task team
 * counts share one seam.
 */
export function countByTeam<T extends { teamName?: string }>(items: T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.teamName) continue;
    counts.set(item.teamName, (counts.get(item.teamName) ?? 0) + 1);
  }
  return counts;
}

/** Count of agents per team name (agents without a team are skipped). */
export function computeTeamCounts(agents: Agent[]): Map<string, number> {
  return countByTeam(agents);
}
