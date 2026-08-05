// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  dedupeBrainAutopilotGoals,
  dedupeBrainGoalInstructions,
  isGoalAutopilotRunDue,
  normalizeGoalAutopilotControlConfig,
} from '../../src/agent-manager-db.js';

describe('goal autopilot hardening', () => {
  it('normalizes manager-owned cadence and fanout bounds', () => {
    const fallback = { enabled: true, cadenceMs: 15 * 60_000, maxTasksPerRun: 3 };
    expect(normalizeGoalAutopilotControlConfig({
      enabled: false,
      cadenceMs: 1,
      maxTasksPerRun: 99,
    }, fallback)).toEqual({
      enabled: false,
      cadenceMs: 5 * 60_000,
      maxTasksPerRun: 12,
    });
  });

  it('coalesces missed ticks and guards an unfinished run', () => {
    const config = { enabled: true, cadenceMs: 30 * 60_000, maxTasksPerRun: 3 };
    const now = 1_800_000_000_000;
    expect(isGoalAutopilotRunDue(config, null, now)).toBe(true);
    expect(isGoalAutopilotRunDue(config, { lastCompletedAt: now - 10 * 60_000 }, now)).toBe(false);
    expect(isGoalAutopilotRunDue(config, { lastCompletedAt: now - 31 * 60_000 }, now)).toBe(true);
    expect(isGoalAutopilotRunDue(config, {
      lastStartedAt: now - 5 * 60_000,
      lastCompletedAt: now - 60 * 60_000,
    }, now)).toBe(false);
    expect(isGoalAutopilotRunDue({ ...config, enabled: false }, null, now)).toBe(false);
  });

  it('prefers the canonical active-goal instruction over the legacy autopilot copy', () => {
    const base = {
      source_id: 'memory:1',
      memory_id: 1,
      content: 'same goal',
      scope: { project: 'default' },
    };
    const result = dedupeBrainGoalInstructions([
      { ...base, key: 'goals:autopilot:default' },
      { ...base, source_id: 'memory:2', memory_id: 2, key: 'goals:active:default' },
      { ...base, source_id: 'memory:3', memory_id: 3, key: 'other:default', content: 'other instruction' },
    ]);
    expect(result.map((item) => item.key)).toEqual(['goals:active:default', 'other:default']);
  });

  it('coalesces canonical and legacy Brain rows into one logical autopilot goal', () => {
    const base = {
      name: 'Improve task throughput',
      status: 'active',
      teamName: 'default',
      priority: 'primary',
      agentName: 'lead',
    };
    const result = dedupeBrainAutopilotGoals([
      {
        ...base,
        id: 'goal:goal-one',
        data: { autopilot: true, driver: { lastRunAt: 100, taskRefs: ['#aaaa'] } },
        updatedAt: 110,
        lastRunAt: 100,
        taskRefs: ['#aaaa'],
      },
      {
        ...base,
        id: 'goal:goal-one#legacy-deadbeef',
        data: { autopilot: true, driver: { lastRunAt: 200, taskRefs: ['#bbbb'] } },
        updatedAt: 210,
        lastRunAt: 200,
        taskRefs: ['#bbbb'],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('goal:goal-one');
    expect(result[0].lastRunAt).toBe(200);
    expect(result[0].taskRefs).toEqual(['#aaaa', '#bbbb']);
    expect(result[0].data.driver).toMatchObject({ lastRunAt: 200, taskRefs: ['#aaaa', '#bbbb'] });
  });
});
