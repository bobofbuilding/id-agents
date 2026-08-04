import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Brain goal-driver authorization', () => {
  it('uses the shared authenticated Brain headers for goal-driver writes', () => {
    const source = readFileSync(new URL('../../src/agent-manager-db.ts', import.meta.url), 'utf8');
    const method = source.match(
      /private async updateBrainGoalDriver\([\s\S]*?\n  private async listOpenTasksForTeam/,
    )?.[0] ?? '';

    expect(method).toContain("headers: { ...this.brainHeaders(), accept: 'application/json' }");
    expect(method).not.toContain("headers: { 'content-type': 'application/json'");
  });
});
