// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  initialCommandBuffer,
  resolveAgentTargetTeam,
} from '../../src/tui/App.js';
import type { Agent } from '../../src/tui/api/types.js';

function agent(name: string, teamName: string): Agent {
  return {
    id: `${teamName}:${name}`,
    name,
    port: 0,
    status: 'running',
    health: 'online',
    createdAt: 0,
    teamName,
  };
}

describe('TUI default speech target', () => {
  it('opens slash command mode as an ask prompt to the default team lead', () => {
    expect(initialCommandBuffer('/')).toBe('/ask lead ');
    expect(initialCommandBuffer(':')).toBe(':');
  });

  it('prefers default/lead when lead exists in multiple teams', () => {
    const result = resolveAgentTargetTeam('ask', 'lead', [
      agent('lead', 'default'),
      agent('lead', 'starter-pair'),
    ]);

    expect(result).toEqual({ teamName: 'default' });
  });

  it('preserves ambiguity checks for non-default targets', () => {
    const result = resolveAgentTargetTeam('ask', 'worker', [
      agent('worker', 'default'),
      agent('worker', 'ops-team'),
    ]);

    expect(result.error).toContain('exists in multiple teams');
  });
});
