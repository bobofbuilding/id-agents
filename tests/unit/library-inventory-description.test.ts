// SPDX-License-Identifier: MIT
/**
 * Slice 2: README-first description on library inventory list/detail.
 *
 * Library entries are human-authored personas — the canonical place to
 * find a one-line description is the entry's README (or, for skills,
 * the SKILL.md frontmatter). The inventory must surface that string in
 * the `description` field rather than asking the TUI to fall back on a
 * config-derived summary.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  listLibraryAgents,
  getLibraryAgent,
  listLibrarySkills,
  getLibrarySkill,
  listLibraryTeams,
  getLibraryTeam,
} from '../../src/lib/library-inventory.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-inv-desc-'));
}

function write(p: string, body = ''): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe('library inventory — README-first description', () => {
  let root: string;

  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /* ------------------------------- agents ------------------------------- */

  it('agent list/detail surface the first README body paragraph', () => {
    const agentDir = path.join(root, 'agents', 'pro-writer');
    write(path.join(agentDir, 'CLAUDE.md'), '# Pro writer persona body');
    write(
      path.join(agentDir, 'README.md'),
      '# pro-writer\n\nConversion copywriter. Writes new marketing copy and hands drafts to the editor.\n\n## Bundled skills\n\n- copywriting\n',
    );

    const list = listLibraryAgents(root);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0].description).toBe(
      'Conversion copywriter. Writes new marketing copy and hands drafts to the editor.',
    );
    expect(list.entries[0].hasReadme).toBe(true);

    const detail = getLibraryAgent(root, 'pro-writer');
    expect(detail?.description).toBe(list.entries[0].description);
  });

  it('agent description is null when no README is present', () => {
    const agentDir = path.join(root, 'agents', 'bare');
    write(path.join(agentDir, 'CLAUDE.md'), '# Bare persona');

    const list = listLibraryAgents(root);
    expect(list.entries[0].hasReadme).toBe(false);
    expect(list.entries[0].description).toBeNull();
  });

  it('agent description skips a leading fenced code block opener', () => {
    const agentDir = path.join(root, 'agents', 'fenced');
    write(path.join(agentDir, 'CLAUDE.md'), '# x');
    write(
      path.join(agentDir, 'README.md'),
      '# fenced\n\n```\nlogo art\n```\n\nReal description starts here on a fresh paragraph.\n',
    );

    const list = listLibraryAgents(root);
    expect(list.entries[0].description).toBe(
      'Real description starts here on a fresh paragraph.',
    );
  });

  /* -------------------------------- teams ------------------------------- */

  it('team list/detail surface the first README body paragraph', () => {
    const teamDir = path.join(root, 'teams', 'starter-pair');
    write(
      path.join(teamDir, 'team.yaml'),
      'version: "1"\nteam: starter-pair\nagents:\n  - name: lead\n',
    );
    write(
      path.join(teamDir, 'README.md'),
      '# starter-pair\n\nA minimal two-agent team — lead plans and reviews, dev implements.\n',
    );

    const list = listLibraryTeams(root);
    expect(list.entries[0].description).toBe(
      'A minimal two-agent team — lead plans and reviews, dev implements.',
    );

    const detail = getLibraryTeam(root, 'starter-pair');
    expect(detail?.description).toBe(list.entries[0].description);
    expect(detail?.declaredTeam).toBe('starter-pair');
  });

  it('team description is null when no README is present', () => {
    const teamDir = path.join(root, 'teams', 'no-readme');
    write(
      path.join(teamDir, 'team.yaml'),
      'version: "1"\nteam: no-readme\nagents:\n  - name: lead\n',
    );

    const list = listLibraryTeams(root);
    expect(list.entries[0].description).toBeNull();
  });

  /* ------------------------------- skills ------------------------------- */

  it('skill list/detail prefer SKILL.md frontmatter description', () => {
    const skillDir = path.join(root, 'skills', 'using-foundry');
    write(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: using-foundry\ndescription: Drive Foundry from inside an agent — forge build, test, snapshot, deploy.\n---\n\nSKILL body content goes here. Not used for description when frontmatter is present.\n',
    );

    const list = listLibrarySkills(root);
    expect(list.entries[0].description).toBe(
      'Drive Foundry from inside an agent — forge build, test, snapshot, deploy.',
    );

    const detail = getLibrarySkill(root, 'using-foundry');
    expect(detail?.description).toBe(list.entries[0].description);
  });

  it('skill description falls back to first body paragraph when frontmatter is missing', () => {
    const skillDir = path.join(root, 'skills', 'no-frontmatter');
    write(
      path.join(skillDir, 'SKILL.md'),
      '# No frontmatter\n\nA skill missing frontmatter still carries a body — surface the first paragraph.\n',
    );

    const list = listLibrarySkills(root);
    expect(list.entries[0].description).toBe(
      'A skill missing frontmatter still carries a body — surface the first paragraph.',
    );

    const detail = getLibrarySkill(root, 'no-frontmatter');
    expect(detail?.description).toBe(list.entries[0].description);
  });
});
