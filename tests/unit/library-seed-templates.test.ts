// SPDX-License-Identifier: MIT
/**
 * Slice 2 sanity check — the in-repo seed library templates under
 * `configs/teams/<name>/` parse cleanly via the YAML Document AST,
 * declare the right top-level `team:` field, and install through the
 * slice-1 endpoint with the expected provenance header.
 *
 * Guards against silent drift: editing a seed template that breaks
 * AST parsing or the install contract should fail in CI rather than
 * surface at user-install time.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseDocument } from 'yaml';

import { installLibraryTeam } from '../../src/lib/library-install.js';
import { listLibraryTeams, getLibraryTeam } from '../../src/lib/library-inventory.js';

const SEED_NAMES = ['starter-pair', 'solidity-pair'] as const;
const REPO_TEAMS_DIR = path.resolve(__dirname, '../../configs/teams');

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-seed-'));
}

describe('seed team templates under configs/teams/', () => {
  for (const name of SEED_NAMES) {
    it(`${name}/team.yaml parses via Document AST and declares team: ${name}`, () => {
      const raw = fs.readFileSync(path.join(REPO_TEAMS_DIR, name, 'team.yaml'), 'utf-8');
      const doc = parseDocument(raw);
      expect(doc.errors).toEqual([]);
      expect(doc.get('team')).toBe(name);
    });

    it(`${name} ships a README that surfaces a description via the inventory`, () => {
      const list = listLibraryTeams(path.resolve(REPO_TEAMS_DIR, '..'));
      const entry = list.entries.find(e => e.name === name);
      expect(entry, `entry ${name} should be enumerated`).toBeTruthy();
      expect(entry?.hasReadme).toBe(true);
      expect(entry?.description, `${name} README must produce a non-null description`).toBeTruthy();

      const detail = getLibraryTeam(path.resolve(REPO_TEAMS_DIR, '..'), name);
      expect(detail?.description).toBe(entry?.description);
    });
  }

  describe('install end-to-end', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = mkTmp();
      fs.cpSync(REPO_TEAMS_DIR, path.join(tmpRoot, 'teams'), { recursive: true });
    });
    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('starter-pair installs with the expected provenance header and AST-rewritten team:', () => {
      const result = installLibraryTeam(
        tmpRoot,
        { template: 'starter-pair', dest: 'my-starter' },
        new Date('2026-05-11T12:00:00Z'),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const written = fs.readFileSync(result.destPath, 'utf-8');
      const firstLine = written.split('\n', 1)[0];
      expect(firstLine).toMatch(
        /^# Installed from configs\/teams\/starter-pair\/team\.yaml on \d{4}-\d{2}-\d{2}$/,
      );

      // Body still parses cleanly and reflects the rewritten team name.
      const doc = parseDocument(written);
      expect(doc.errors).toEqual([]);
      expect(doc.get('team')).toBe('my-starter');
    });

    it('solidity-pair installs and preserves peer agent: / skills: structure', () => {
      const result = installLibraryTeam(
        tmpRoot,
        { template: 'solidity-pair', dest: 'audit-pair' },
        new Date('2026-05-11T12:00:00Z'),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const written = fs.readFileSync(result.destPath, 'utf-8');
      const doc = parseDocument(written);
      expect(doc.errors).toEqual([]);
      expect(doc.get('team')).toBe('audit-pair');

      // Peer agent: and skills: are NOT nested — they live side-by-side on
      // each agent entry. Re-parse as a plain object and verify shape.
      const obj = doc.toJS() as {
        agents: Array<{ name: string; agent?: string; skills?: string[] }>;
      };
      const builder = obj.agents.find(a => a.name === 'builder');
      expect(builder?.agent).toBe('foundry-dev');
      expect(Array.isArray(builder?.skills)).toBe(true);
    });
  });
});
