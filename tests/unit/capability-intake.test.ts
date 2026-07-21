// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { buildCapabilityIntakeRecord } from '../../src/capability-intake.js';

describe('capability intake', () => {
  it('records provenance, permissions, compatibility, rollback, and re-evaluation', () => {
    const record = buildCapabilityIntakeRecord({
      kind: 'skill',
      name: 'research',
      source: '/library/research/SKILL.md',
      content: '# Research',
      owner: 'research-lead',
      runtime: 'codex-cli',
      nowMs: 1_000,
    });
    expect(record.status).toBe('approved');
    expect((record.provenance as any).sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.rollback).toContain('uninstall');
    expect(record.re_evaluate_at).toBeGreaterThan(1_000);
  });

  it('blocks empty or unowned capabilities', () => {
    const record = buildCapabilityIntakeRecord({
      kind: 'plugin',
      name: 'bad',
      source: '',
      content: '',
      owner: '',
      runtime: '',
      nowMs: 1_000,
    });
    expect(record.status).toBe('blocked');
    expect(record.blockers).toEqual(expect.arrayContaining(['missing_provenance', 'empty_capability', 'missing_owner']));
  });
});
