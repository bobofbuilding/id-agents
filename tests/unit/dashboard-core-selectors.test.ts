// SPDX-License-Identifier: MIT
/**
 * Unit tests for the renderer-neutral selection/normalization seams extracted
 * from src/tui/App.tsx in commit 3.
 */

import { describe, expect, it } from 'vitest';
import {
  orderTeams,
  filterAgentsByTeam,
  isRemoteAgent,
  localAgentIds,
  computeTeamCounts,
  filterTasksByTeam,
  sortNewsByTimestamp,
  filterCalendarSchedules,
  clampIndex,
  clampScroll,
} from '../../src/dashboard-core/selectors/index.js';
import type { Agent, NewsItem, Schedule, Task, Team } from '../../src/dashboard-core/api/types.js';

const team = (name: string): Team => ({ name });
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ id, name: id, ...over });
const task = (name: string, over: Partial<Task> = {}): Task =>
  ({ name, title: name, status: 'todo', createdAt: 0, ...over });
const news = (timestamp: number): NewsItem => ({ type: 'x', timestamp });
const sched = (over: Partial<Schedule>): Schedule =>
  ({
    id: 's',
    title: 't',
    kind: 'calendar',
    active: true,
    targets: [],
    intervalSeconds: null,
    timezone: null,
    localTimeSeconds: null,
    localDate: null,
    daysOfWeek: null,
    createdAt: 0,
    ...over,
  });

describe('selectors/agents', () => {
  it('orderTeams pins public first, keeps the rest in order', () => {
    expect(orderTeams([team('a'), team('public'), team('b')]).map((t) => t.name)).toEqual([
      'public',
      'a',
      'b',
    ]);
    expect(orderTeams([team('a'), team('b')]).map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('filterAgentsByTeam returns all for null, else the team subset', () => {
    const agents = [agent('1', { teamName: 'x' }), agent('2', { teamName: 'y' })];
    expect(filterAgentsByTeam(agents, null)).toHaveLength(2);
    expect(filterAgentsByTeam(agents, 'x').map((a) => a.id)).toEqual(['1']);
  });

  it('isRemoteAgent detects deployment shape and remote runtime', () => {
    expect(isRemoteAgent(agent('1', { deploymentShape: 'remote-endpoint' }))).toBe(true);
    expect(isRemoteAgent(agent('2', { metadata: { runtime: 'public-agent-remote' } }))).toBe(true);
    expect(isRemoteAgent(agent('3', { deploymentShape: 'local-process' }))).toBe(false);
    expect(isRemoteAgent(agent('4'))).toBe(false);
  });

  it('localAgentIds excludes remote agents', () => {
    const ids = localAgentIds([
      agent('local'),
      agent('remote', { deploymentShape: 'remote-endpoint' }),
    ]);
    expect([...ids]).toEqual(['local']);
  });

  it('computeTeamCounts tallies by team and skips team-less agents', () => {
    const counts = computeTeamCounts([
      agent('1', { teamName: 'x' }),
      agent('2', { teamName: 'x' }),
      agent('3', { teamName: 'y' }),
      agent('4'),
    ]);
    expect(counts.get('x')).toBe(2);
    expect(counts.get('y')).toBe(1);
    expect(counts.size).toBe(2);
  });
});

describe('selectors/tasks + news', () => {
  it('filterTasksByTeam returns all for null, else the team subset', () => {
    const tasks = [task('a', { teamName: 'x' }), task('b', { teamName: 'y' })];
    expect(filterTasksByTeam(tasks, null)).toHaveLength(2);
    expect(filterTasksByTeam(tasks, 'y').map((t) => t.name)).toEqual(['b']);
  });

  it('sortNewsByTimestamp is newest-first and does not mutate the input', () => {
    const input = [news(1), news(3), news(2)];
    const sorted = sortNewsByTimestamp(input);
    expect(sorted.map((n) => n.timestamp)).toEqual([3, 2, 1]);
    expect(input.map((n) => n.timestamp)).toEqual([1, 3, 2]); // unchanged
  });
});

describe('selectors/schedule filtering', () => {
  it('filterCalendarSchedules drops heartbeat kind and "Heartbeat: …" titles', () => {
    const rows = [
      sched({ id: 'a', kind: 'calendar', title: 'Standup' }),
      sched({ id: 'b', kind: 'heartbeat', title: 'hb' }),
      sched({ id: 'c', kind: 'calendar', title: 'Heartbeat: contracts' }),
    ];
    expect(filterCalendarSchedules(rows).map((s) => s.id)).toEqual(['a']);
  });
});

describe('selectors/selection clamping', () => {
  it('clampIndex bounds the index into [0, total)', () => {
    expect(clampIndex(3, 0)).toBe(0);
    expect(clampIndex(2, 10)).toBe(2);
    expect(clampIndex(20, 10)).toBe(9);
    expect(clampIndex(5, 5)).toBe(4);
  });

  it('clampScroll resets on empty and keeps an in-range selection visible', () => {
    expect(clampScroll(3, 2, 0, 5)).toEqual({ index: 0, windowStart: 0 });
    expect(clampScroll(2, 0, 10, 5)).toEqual({ index: 2, windowStart: 0 });
  });

  it('clampScroll scrolls the window down and up to reveal the selection', () => {
    expect(clampScroll(7, 0, 10, 5)).toEqual({ index: 7, windowStart: 3 });
    expect(clampScroll(1, 4, 10, 5)).toEqual({ index: 1, windowStart: 1 });
  });

  it('clampScroll clamps an out-of-range index and bounds the window start', () => {
    expect(clampScroll(20, 0, 10, 5)).toEqual({ index: 9, windowStart: 5 });
    expect(clampScroll(9, 8, 10, 5)).toEqual({ index: 9, windowStart: 5 });
  });
});
