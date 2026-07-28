// SPDX-License-Identifier: MIT

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  INTER_AGENT_SKILL,
  INTER_AGENT_SKILL_LIGHT,
  stripYamlFrontmatter,
  withInterAgentSkill,
} from '../../src/inter-agent-skill.js';

const SKILL_MD_PATH = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'skills',
  'inter-agent',
  'SKILL.md'
);

describe('INTER_AGENT_SKILL — consumer-safe delegation flow', () => {
  it('uses only runtime-provided Manager and private wrapper addresses', () => {
    expect(INTER_AGENT_SKILL).toContain('`ID_AGENT_PORT`');
    expect(INTER_AGENT_SKILL).toContain('`MANAGER_URL`');
    expect(INTER_AGENT_SKILL).toContain('$MANAGER_URL/agents');
    expect(INTER_AGENT_SKILL).toContain('127.0.0.1:$ID_AGENT_PORT');
  });

  it('contains no fixed peer ports, raw admin relay, or checkout assumptions', () => {
    expect(INTER_AGENT_SKILL).not.toMatch(/localhost:<peer-port>|127\.0\.0\.1:(?:4050|4100|4200)/);
    expect(INTER_AGENT_SKILL).not.toContain('$MANAGER_URL/remote');
    expect(INTER_AGENT_SKILL).not.toMatch(/(?:^|\s)\/ask(?:\s|$)/);
    expect(INTER_AGENT_SKILL).not.toMatch(/\/workspace\/teams|project_root|task_ref/);
  });

  it('discovers current teammates before routing by catalog evidence', () => {
    const discovery = INTER_AGENT_SKILL.split('## Discover available teammates')[1]?.split('## Synchronous request')[0] ?? '';
    expect(discovery).toContain('$MANAGER_URL/agents');
    expect(discovery).toContain('X-Id-Team: $ID_TEAM');
    expect(discovery).toContain('X-Id-Agent: $ID_AGENT_ID');
    expect(discovery).toContain('Authorization: Bearer $IDACC_MANAGER_AGENT_TOKEN');
    expect(discovery).toContain('/catalog');
    expect(discovery).toContain('role');
    expect(discovery).toContain('expertise');
    expect(discovery).toContain('availability');
    expect(discovery).toContain('cost tier');
    expect(discovery).toContain('notSuitableFor');
    expect(discovery).toMatch(/Do not select an agent\s+from its name alone/i);
  });

  it('limits direct coordination to the current team', () => {
    expect(INTER_AGENT_SKILL).toContain('current team');
    expect(INTER_AGENT_SKILL).toContain('cross-team administration belong in the IDACC application');
    expect(INTER_AGENT_SKILL).not.toMatch(/other-team\/agent|cross-team delegation/i);
  });

  it('uses talk-to only for a reply that is required before continuing', () => {
    const synchronous = INTER_AGENT_SKILL.split('## Synchronous request')[1]?.split('## Asynchronous delegation')[0] ?? '';
    expect(synchronous).toContain('/talk-to');
    expect(synchronous).toMatch(/reply is needed before you can continue/i);
    expect(synchronous).toMatch(/Include that response/i);
  });

  it('uses news-to with a literal trigger and stable task identity for asynchronous work', () => {
    const asynchronous = INTER_AGENT_SKILL.split('## Asynchronous delegation')[1]?.split('## Read your news cursor')[0] ?? '';
    expect(asynchronous).toContain('/news-to');
    expect(asynchronous).toContain('"trigger":true');
    expect(asynchronous).toContain('"task"');
    for (const field of [
      'goal_id',
      'expected_output',
      'acceptance_criteria',
      'validation_path',
      'out_of_scope',
      'backlog_policy',
      'work_relevance',
    ]) {
      expect(asynchronous).toContain(`"${field}"`);
    }
    expect(asynchronous).toMatch(/Reuse that exact task name/i);
  });

  it('documents a passive notice that cannot start a model turn', () => {
    expect(INTER_AGENT_SKILL).toMatch(/passive status notice[\s\S]{0,160}omit `trigger`/i);
    expect(INTER_AGENT_SKILL).toContain('The evidence packet is ready for review.');
  });

  it('uses the private loopback reply feed instead of the Manager query endpoint', () => {
    expect(INTER_AGENT_SKILL).toContain('since_id=0&limit=100');
    expect(INTER_AGENT_SKILL).toContain('next_since_id');
    expect(INTER_AGENT_SKILL).toContain(
      '127.0.0.1:$ID_AGENT_PORT/news?since_id=0&query_id=$QID&limit=100',
    );
    expect(INTER_AGENT_SKILL).toMatch(/Do not poll the\s+Manager's profile-wide `\/query` endpoint/i);
    expect(INTER_AGENT_SKILL).not.toContain('$MANAGER_URL/query/');
  });

  it('requires a bounded handoff packet and protects profile credentials', () => {
    expect(INTER_AGENT_SKILL).toContain('## Delegation packet');
    expect(INTER_AGENT_SKILL).toContain('exact objective and expected deliverable');
    expect(INTER_AGENT_SKILL).toContain('smallest necessary scope');
    expect(INTER_AGENT_SKILL).toContain('acceptance evidence');
    expect(INTER_AGENT_SKILL).toContain('authority limits');
    expect(INTER_AGENT_SKILL).toContain('Do not include credentials, unrelated profile data');
    expect(INTER_AGENT_SKILL).toMatch(
      /Never print, persist,\s+forward, or send it to another agent/i,
    );
    expect(INTER_AGENT_SKILL).toMatch(/evidence to review, not as\s+automatic authorization/i);
  });

  it('keeps the lightweight contract under the same consumer-safety boundary', () => {
    expect(INTER_AGENT_SKILL_LIGHT).toContain('$MANAGER_URL/agents');
    expect(INTER_AGENT_SKILL_LIGHT).toContain('X-Id-Agent: $ID_AGENT_ID');
    expect(INTER_AGENT_SKILL_LIGHT).toContain('Authorization: Bearer $IDACC_MANAGER_AGENT_TOKEN');
    expect(INTER_AGENT_SKILL_LIGHT).toContain('127.0.0.1:$ID_AGENT_PORT/talk-to');
    expect(INTER_AGENT_SKILL_LIGHT).toContain('127.0.0.1:$ID_AGENT_PORT/news-to');
    expect(INTER_AGENT_SKILL_LIGHT).toContain(
      '127.0.0.1:$ID_AGENT_PORT/news?since_id=0&query_id=$QID&limit=100',
    );
    expect(INTER_AGENT_SKILL_LIGHT).toContain('"goal_id"');
    expect(INTER_AGENT_SKILL_LIGHT).toContain('"work_relevance"');
    expect(INTER_AGENT_SKILL_LIGHT).toContain('Never print, persist, or forward `IDACC_MANAGER_AGENT_TOKEN`');
    expect(INTER_AGENT_SKILL_LIGHT).not.toContain('$MANAGER_URL/query/');
    expect(INTER_AGENT_SKILL_LIGHT).not.toContain('$MANAGER_URL/remote');
    expect(INTER_AGENT_SKILL_LIGHT).not.toMatch(/\/workspace\/teams|other-team\/agent|localhost:<peer-port>/);
  });
});

describe('INTER_AGENT_SKILL — single source of truth (skills/inter-agent/SKILL.md)', () => {
  it('TS export matches the MD file body (frontmatter stripped) — divergence guard', () => {
    // skills/inter-agent/SKILL.md is the source of truth. INTER_AGENT_SKILL is
    // loaded from it at module init. If anyone edits the TS export by hand
    // and lets it drift from the MD, this assertion fires.
    const raw = readFileSync(SKILL_MD_PATH, 'utf8');
    const expectedBody = stripYamlFrontmatter(raw);
    // The export prepends a single newline for legacy formatting parity; trim
    // a leading newline before comparing so the assertion is content-only.
    expect(INTER_AGENT_SKILL.replace(/^\n/, '')).toBe(expectedBody);
  });

  it('stripYamlFrontmatter removes a leading --- ... --- block and leaves body untouched', () => {
    const sample = '---\nname: x\ndescription: y\n---\n# Body\nhello';
    expect(stripYamlFrontmatter(sample)).toBe('# Body\nhello');
    // No frontmatter → returned unchanged
    expect(stripYamlFrontmatter('# Body\nhello')).toBe('# Body\nhello');
  });

  it('lightweight skill remains a separate, hand-maintained inline string', () => {
    // The lightweight skill is intentionally NOT loaded from disk — it's a
    // shorter inline variant for non-Claude / cost-sensitive models and uses
    // the {{}} placeholder substitution pattern at runtime.
    const out = withInterAgentSkill('BASE PROMPT BODY', { name: 'lite-agent', team: 'lite-team' }, { lightweight: true });
    expect(out).toContain('BASE PROMPT BODY');
    expect(out).not.toContain('{{AGENT_NAME}}');
    expect(out).not.toContain('{{TEAM_NAME}}');
    expect(out).toContain('lite-agent');
    expect(out).toContain('lite-team');
    expect(INTER_AGENT_SKILL_LIGHT).toContain('/agents');
    // Sanity: lightweight is materially shorter than the full skill.
    expect(INTER_AGENT_SKILL_LIGHT.length).toBeLessThan(INTER_AGENT_SKILL.length);
  });
});
