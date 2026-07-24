// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { PROTOCOL_DEFAULTS } from '../../src/protocol-defaults.js';

describe('PROTOCOL_DEFAULTS', () => {
  it('is a non-empty string', () => {
    expect(typeof PROTOCOL_DEFAULTS).toBe('string');
    expect(PROTOCOL_DEFAULTS.length).toBeGreaterThan(0);
  });

  it('contains scheduling section', () => {
    expect(PROTOCOL_DEFAULTS).toContain('## Scheduling');
    expect(PROTOCOL_DEFAULTS).toContain('manager-owned scheduler');
  });

  it('bounds shell and filesystem discovery', () => {
    expect(PROTOCOL_DEFAULTS).toContain('## Shell And Resource Discipline');
    expect(PROTOCOL_DEFAULTS).toContain('Prefer `rg` and `rg --files`');
    expect(PROTOCOL_DEFAULTS).toContain('Do not scan `/`, `/Users`, `$HOME`');
    expect(PROTOCOL_DEFAULTS).toContain('Long scans');
  });

  it('contains task discipline section', () => {
    expect(PROTOCOL_DEFAULTS).toContain('## Task Discipline');
    expect(PROTOCOL_DEFAULTS).toContain('task lifecycle');
  });

  it('contains output convention section', () => {
    expect(PROTOCOL_DEFAULTS).toContain('## Output Convention');
    expect(PROTOCOL_DEFAULTS).toContain('./output/');
  });

  it('defines memory horizons and guarded promotion', () => {
    expect(PROTOCOL_DEFAULTS).toContain('### Memory horizons');
    expect(PROTOCOL_DEFAULTS).toContain('**core**');
    expect(PROTOCOL_DEFAULTS).toContain('**long_term**');
    expect(PROTOCOL_DEFAULTS).toContain('**medium_term**');
    expect(PROTOCOL_DEFAULTS).toContain('**short_term**');
    expect(PROTOCOL_DEFAULTS).toContain('Core constraints outrank');
    expect(PROTOCOL_DEFAULTS).toContain('evidence, validation, and a stable owner');
  });

  it('contains lifecycle steps', () => {
    expect(PROTOCOL_DEFAULTS).toContain('POST $MANAGER_URL/tasks');
    expect(PROTOCOL_DEFAULTS).toContain('/tasks/<name>/claim');
    expect(PROTOCOL_DEFAULTS).toContain('/tasks/<name>/done');
  });

  it('distinguishes assigned vs self-initiated work and points at the skills', () => {
    expect(PROTOCOL_DEFAULTS).toContain('Assigned vs self-initiated work');
    expect(PROTOCOL_DEFAULTS).toContain('do NOT create a parallel task');
    expect(PROTOCOL_DEFAULTS).toContain('.agents/skills/task-discipline/SKILL.md');
    expect(PROTOCOL_DEFAULTS).toContain('.agents/skills/inter-agent/SKILL.md');
    expect(PROTOCOL_DEFAULTS).toContain('.claude/skills/...');
  });

  it('documents the orphan-cleanup close-note format verbatim', () => {
    expect(PROTOCOL_DEFAULTS).toContain('Orphan cleanup notes');
    expect(PROTOCOL_DEFAULTS).toContain(
      'closed-by-cleanup: see <implementer-task-name> (uuid <short>)',
    );
  });
});
