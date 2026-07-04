// SPDX-License-Identifier: MIT

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';

import {
  installLibraryTeam,
  parseSelector,
} from '../../src/lib/library-install.js';
import {
  listLibraryTeams,
  getLibraryTeam,
} from '../../src/lib/library-inventory.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-install-'));
}

function writeFile(p: string, content = ''): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const SAMPLE_TEMPLATE = `# Demo Team — clean playground
version: "1"
team: demo-team

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-sonnet-5
  skills:
    - identity
    - inter-agent
    - catalog

agents:
  - name: lead
    description: "Demo lead — orchestrates the others"

  - name: dev
    description: "Generalist developer"

  - name: scout
    description: "Research and exploration"
`;

/**
 * Hostile fixture exercising the nested-key preservation contract: a
 * top-level `team:` field PLUS multiple nested occurrences of `team:`
 * (inside a map entry, inside a list-of-maps entry, and inside a
 * string value). All nested occurrences must survive a rewrite of the
 * top-level field untouched.
 */
const NESTED_TEAM_FIXTURE = `version: "1"
team: alpha

# nested 'team:' below must remain untouched after rewrite
defaults:
  team: not-the-real-team       # nested under defaults
  notes: |
    this team: value is inside a string
    multi-line block scalar

agents:
  - name: lead
    description: "leads team: but as text"
    metadata:
      team: nested-list-entry
  - name: scout
    description: "scouting"
`;

describe('parseSelector', () => {
  it('parses a valid kind:name selector', () => {
    expect(parseSelector('team:demo-team')).toEqual({ kind: 'team', name: 'demo-team' });
    expect(parseSelector('agent:coder')).toEqual({ kind: 'agent', name: 'coder' });
  });

  it('rejects malformed selectors', () => {
    expect(parseSelector('demo-team')).toBeNull();
    expect(parseSelector(':demo')).toBeNull();
    expect(parseSelector('team:')).toBeNull();
    expect(parseSelector('')).toBeNull();
    expect(parseSelector(null)).toBeNull();
    expect(parseSelector(123)).toBeNull();
  });

  it('keeps everything after the first colon as the name', () => {
    expect(parseSelector('team:demo:team')).toEqual({ kind: 'team', name: 'demo:team' });
  });
});

describe('listLibraryTeams / getLibraryTeam', () => {
  let libRoot: string;

  beforeEach(() => {
    libRoot = mkTmp();
  });

  afterEach(() => {
    fs.rmSync(libRoot, { recursive: true, force: true });
  });

  it('returns null library when no root is configured', () => {
    expect(listLibraryTeams(null)).toEqual({ libraryRoot: null, entries: [] });
    expect(getLibraryTeam(null, 'demo')).toBeNull();
  });

  it('returns empty list when teams dir does not exist', () => {
    const result = listLibraryTeams(libRoot);
    expect(result).toEqual({ libraryRoot: libRoot, entries: [] });
  });

  it('lists installable team entries with metadata flags', () => {
    writeFile(path.join(libRoot, 'teams', 'demo', 'team.yaml'), SAMPLE_TEMPLATE);
    writeFile(path.join(libRoot, 'teams', 'demo', 'README.md'), '# demo readme');

    const result = listLibraryTeams(libRoot);
    expect(result.libraryRoot).toBe(libRoot);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      name: 'demo',
      hasReadme: true,
      hasLicense: false,
      hasTeamYaml: true,
      source_path: path.join(libRoot, 'teams', 'demo'),
      // README is a bare title with no body paragraph — README-first
      // description resolution returns null in that case.
      description: null,
    });
  });

  it('detail returns declaredTeam and parsed agents list', () => {
    writeFile(path.join(libRoot, 'teams', 'demo-team', 'team.yaml'), SAMPLE_TEMPLATE);

    const detail = getLibraryTeam(libRoot, 'demo-team');
    expect(detail).not.toBeNull();
    expect(detail!.declaredTeam).toBe('demo-team');
    expect(detail!.agents).toEqual(['lead', 'dev', 'scout']);
    expect(detail!.teamYaml).toBe(SAMPLE_TEMPLATE);
    expect(detail!.teamYamlFile).toBe(path.join(libRoot, 'teams', 'demo-team', 'team.yaml'));
  });

  it('detail returns 404-equivalent null for unknown name', () => {
    expect(getLibraryTeam(libRoot, 'missing')).toBeNull();
  });

  it('detail falls back to empty agents when agents: is missing or malformed', () => {
    writeFile(
      path.join(libRoot, 'teams', 'bare', 'team.yaml'),
      `team: bare\nagents: "not a list"\n`,
    );
    const detail = getLibraryTeam(libRoot, 'bare');
    expect(detail!.declaredTeam).toBe('bare');
    expect(detail!.agents).toEqual([]);
  });

  it('detail returns declaredTeam null when top-level team: is absent', () => {
    writeFile(path.join(libRoot, 'teams', 'no-team', 'team.yaml'), `version: "1"\n`);
    const detail = getLibraryTeam(libRoot, 'no-team');
    expect(detail!.declaredTeam).toBeNull();
  });
});

describe('installLibraryTeam', () => {
  let libRoot: string;
  // Pinned date for deterministic provenance assertions.
  const fixedNow = new Date(2026, 4, 11); // 2026-05-11

  beforeEach(() => {
    libRoot = mkTmp();
  });

  afterEach(() => {
    fs.rmSync(libRoot, { recursive: true, force: true });
  });

  function seed(template: string, body: string = SAMPLE_TEMPLATE): string {
    const tplDir = path.join(libRoot, 'teams', template);
    writeFile(path.join(tplDir, 'team.yaml'), body);
    return path.join(tplDir, 'team.yaml');
  }

  it('refuses when libraryRoot is null', () => {
    const r = installLibraryTeam(null, { template: 'demo', dest: 'myteam' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('no_library_root');
  });

  it('refuses unknown template with 404', () => {
    const r = installLibraryTeam(libRoot, { template: 'missing', dest: 'myteam' }, fixedNow);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.error).toBe('not_found');
    }
  });

  it('refuses bad template / dest names', () => {
    seed('demo');
    const r1 = installLibraryTeam(libRoot, { template: '../etc/passwd', dest: 'ok' }, fixedNow);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe('bad_template_name');

    const r2 = installLibraryTeam(libRoot, { template: 'demo', dest: '../boom' }, fixedNow);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe('bad_dest_name');
  });

  it('happy path: writes <dest>.yaml with rewritten top-level team and provenance header', () => {
    seed('demo-team');
    const r = installLibraryTeam(libRoot, { template: 'demo-team', dest: 'myteam' }, fixedNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.destPath).toBe(path.join(libRoot, 'myteam.yaml'));
    expect(r.overwritten).toBe(false);
    expect(r.declaredTeamBefore).toBe('demo-team');
    expect(r.declaredTeamAfter).toBe('myteam');

    const written = fs.readFileSync(r.destPath, 'utf-8');
    const lines = written.split('\n');
    expect(lines[0]).toBe('# Installed from configs/teams/demo-team/team.yaml on 2026-05-11');

    const parsed = yaml.load(written) as Record<string, unknown>;
    expect(parsed.team).toBe('myteam');
    // agents structure carried through
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect((parsed.agents as Array<{ name: string }>).map(a => a.name))
      .toEqual(['lead', 'dev', 'scout']);
  });

  it('preserves top-level comments from the template', () => {
    seed('demo-team');
    const r = installLibraryTeam(libRoot, { template: 'demo-team', dest: 'myteam' }, fixedNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const written = fs.readFileSync(r.destPath, 'utf-8');
    // The template's `# Demo Team — clean playground` header comment
    // should round-trip through the AST.
    expect(written).toContain('# Demo Team — clean playground');
  });

  it('rewrites ONLY the top-level team:, leaving nested team: keys untouched', () => {
    seed('alpha', NESTED_TEAM_FIXTURE);
    const r = installLibraryTeam(libRoot, { template: 'alpha', dest: 'beta' }, fixedNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const written = fs.readFileSync(r.destPath, 'utf-8');
    const parsed = yaml.load(written) as Record<string, any>;

    // Top-level rewritten.
    expect(parsed.team).toBe('beta');

    // Nested `team:` under defaults preserved.
    expect(parsed.defaults.team).toBe('not-the-real-team');

    // Nested `team:` inside a list-of-maps preserved.
    expect(parsed.agents[0].metadata.team).toBe('nested-list-entry');

    // String values containing the literal 'team:' substring preserved
    // verbatim.
    expect(parsed.defaults.notes).toContain('this team: value is inside a string');
    expect(parsed.agents[0].description).toBe('leads team: but as text');
  });

  it('guard: refuses when template has no top-level team and dest != template', () => {
    seed('headless', `version: "1"\ndefaults:\n  team: nope\nagents: []\n`);
    const r = installLibraryTeam(libRoot, { template: 'headless', dest: 'other' }, fixedNow);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toBe('missing_team_field');
    }
  });

  it('guard: waived when dest === template (self-install)', () => {
    seed('headless', `version: "1"\ndefaults:\n  team: nope\nagents: []\n`);
    const r = installLibraryTeam(libRoot, { template: 'headless', dest: 'headless' }, fixedNow);
    // Self-install still tries to write configs/headless.yaml; since we
    // don't have a top-level `team:` field in the source, the AST set
    // adds one — that's the intended self-install behavior.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.declaredTeamBefore).toBeNull();
    expect(r.declaredTeamAfter).toBe('headless');

    const parsed = yaml.load(fs.readFileSync(r.destPath, 'utf-8')) as Record<string, unknown>;
    expect(parsed.team).toBe('headless');
  });

  it('refuses to overwrite existing dest without force', () => {
    seed('demo-team');
    writeFile(path.join(libRoot, 'myteam.yaml'), 'existing: true\n');
    const r = installLibraryTeam(libRoot, { template: 'demo-team', dest: 'myteam' }, fixedNow);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toBe('dest_exists');
    }
    // Existing file untouched.
    expect(fs.readFileSync(path.join(libRoot, 'myteam.yaml'), 'utf-8')).toBe('existing: true\n');
  });

  it('force overwrites the destination', () => {
    seed('demo-team');
    writeFile(path.join(libRoot, 'myteam.yaml'), 'existing: true\n');
    const r = installLibraryTeam(libRoot, { template: 'demo-team', dest: 'myteam', force: true }, fixedNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.overwritten).toBe(true);

    const parsed = yaml.load(fs.readFileSync(r.destPath, 'utf-8')) as Record<string, unknown>;
    expect(parsed.team).toBe('myteam');
  });

  it('force NEVER overwrites the source template file', () => {
    // Attempt to install a template into its own templates dir path
    // would require dest === template AND <dest>.yaml resolving to the
    // template file. <libRoot>/<dest>.yaml is never the same file as
    // <libRoot>/teams/<template>/team.yaml, so the safety check is
    // structural — but verify the source file is identical after a
    // forced re-install.
    const sourcePath = seed('demo-team');
    const before = fs.readFileSync(sourcePath, 'utf-8');

    const r = installLibraryTeam(libRoot, { template: 'demo-team', dest: 'myteam', force: true }, fixedNow);
    expect(r.ok).toBe(true);

    const after = fs.readFileSync(sourcePath, 'utf-8');
    expect(after).toBe(before);
  });

  it('replaces an existing leading provenance header rather than stacking', () => {
    // Source already starts with a provenance header — this can happen
    // if someone copied an installed config back into the templates dir.
    const sourceWithHeader =
      '# Installed from configs/teams/old/team.yaml on 2020-01-01\n' +
      SAMPLE_TEMPLATE;
    seed('demo-team', sourceWithHeader);

    const r = installLibraryTeam(libRoot, { template: 'demo-team', dest: 'myteam' }, fixedNow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const written = fs.readFileSync(r.destPath, 'utf-8');
    const provenanceLines = written
      .split('\n')
      .filter(l => l.startsWith('# Installed from configs/teams/'));
    expect(provenanceLines).toHaveLength(1);
    expect(provenanceLines[0]).toBe(
      '# Installed from configs/teams/demo-team/team.yaml on 2026-05-11',
    );
  });

  /* ------------------------------------------------------------------ */
  /*  Slice 5: round-trip — install, mutate, re-install with force      */
  /* ------------------------------------------------------------------ */

  it('round-trip force re-install yields a single provenance header and preserves AST structure', () => {
    // Reinstalling a template over a destination that itself carries
    // a previous provenance header must:
    //   1. produce exactly one provenance line on disk (no stacking),
    //   2. set the line to the current install,
    //   3. preserve nested team: keys, comments, and key order via the
    //      Document AST,
    //   4. leave the source template byte-identical.
    seed('demo-team', NESTED_TEAM_FIXTURE);
    const sourceBefore = fs.readFileSync(
      path.join(libRoot, 'teams', 'demo-team', 'team.yaml'),
      'utf-8',
    );

    const firstNow = new Date(2026, 0, 1); // 2026-01-01
    const first = installLibraryTeam(
      libRoot,
      { template: 'demo-team', dest: 'myteam' },
      firstNow,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstBytes = fs.readFileSync(first.destPath, 'utf-8');
    expect(firstBytes.split('\n')[0]).toBe(
      '# Installed from configs/teams/demo-team/team.yaml on 2026-01-01',
    );

    // Second install with a different "today" and force:true.
    const second = installLibraryTeam(
      libRoot,
      { template: 'demo-team', dest: 'myteam', force: true },
      fixedNow, // 2026-05-11
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.overwritten).toBe(true);

    const written = fs.readFileSync(second.destPath, 'utf-8');
    const provenanceLines = written
      .split('\n')
      .filter(l => l.startsWith('# Installed from configs/teams/'));
    // Exactly one — no stacking.
    expect(provenanceLines).toHaveLength(1);
    expect(provenanceLines[0]).toBe(
      '# Installed from configs/teams/demo-team/team.yaml on 2026-05-11',
    );

    // Nested team: keys still intact after force re-install.
    const parsed = yaml.load(written) as Record<string, any>;
    expect(parsed.team).toBe('myteam');
    expect(parsed.defaults.team).toBe('not-the-real-team');
    expect(parsed.agents[0].metadata.team).toBe('nested-list-entry');

    // Source template never touched by either install.
    const sourceAfter = fs.readFileSync(
      path.join(libRoot, 'teams', 'demo-team', 'team.yaml'),
      'utf-8',
    );
    expect(sourceAfter).toBe(sourceBefore);
  });

  it('round-trip: install N times to the same dest is idempotent up to the provenance date', () => {
    // Repeated `force:true` re-installs of the same template/dest must
    // converge: any two installs with the same `now` produce byte-identical
    // files. This is the cheap regression guard against any future
    // string-concatenation or buffer-stacking bug in the install path.
    seed('demo-team');

    const a = installLibraryTeam(
      libRoot,
      { template: 'demo-team', dest: 'myteam', force: true },
      fixedNow,
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const bytesA = fs.readFileSync(a.destPath, 'utf-8');

    const b = installLibraryTeam(
      libRoot,
      { template: 'demo-team', dest: 'myteam', force: true },
      fixedNow,
    );
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const bytesB = fs.readFileSync(b.destPath, 'utf-8');

    expect(bytesB).toBe(bytesA);
  });
});
