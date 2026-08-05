// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';

describe('aggregate plugin, skill, and agent overlay ownership', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-plugin-fallback-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function reconcile(
    manager: AgentManagerDb,
    workingDirectory: string,
    overrides: Record<string, unknown> = {},
  ): any {
    return (manager as any).reconcileAgentManagedOverlay({
      workingDirectory,
      runtime: 'codex',
      templateName: 'worker',
      teamName: 'team',
      displayName: 'worker',
      plugins: [],
      skills: [],
      roleBody: 'Worker role',
      ...overrides,
    });
  }

  it('mirrors complete plugin skill trees and refreshes same-name source content', () => {
    const pluginDir = path.join(tmpDir, 'source-plugin');
    const nestedSkillDir = path.join(pluginDir, 'skills', 'nested-skill');
    fs.mkdirSync(path.join(nestedSkillDir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'SKILL.md'), '# Root plugin skill');
    fs.writeFileSync(path.join(nestedSkillDir, 'SKILL.md'), '# Nested plugin skill v1');
    fs.writeFileSync(path.join(nestedSkillDir, 'references', 'guide.md'), 'asset-v1');

    const agentWorkDir = path.join(tmpDir, 'agent-workdir');
    const manager = new AgentManagerDb(tmpDir, {} as any, { libraryRoot: null });
    const first = reconcile(manager, agentWorkDir, {
      plugins: [{ name: 'demo-plugin', path: pluginDir }],
    });

    expect(first.localPlugins).toEqual([{
      name: 'demo-plugin',
      path: path.join(agentWorkDir, 'plugins', 'demo-plugin'),
    }]);
    for (const root of ['.claude/skills', '.agents/skills', '.cursor/skills']) {
      expect(fs.readFileSync(
        path.join(agentWorkDir, root, 'nested-skill', 'SKILL.md'),
        'utf8',
      )).toContain('v1');
      expect(fs.readFileSync(
        path.join(agentWorkDir, root, 'nested-skill', 'references', 'guide.md'),
        'utf8',
      )).toBe('asset-v1');
    }

    fs.writeFileSync(path.join(nestedSkillDir, 'SKILL.md'), '# Nested plugin skill v2');
    fs.writeFileSync(path.join(nestedSkillDir, 'references', 'guide.md'), 'asset-v2');
    reconcile(manager, agentWorkDir, {
      plugins: [{ name: 'demo-plugin', path: pluginDir }],
    });
    expect(fs.readFileSync(
      path.join(agentWorkDir, '.agents/skills/nested-skill/SKILL.md'),
      'utf8',
    )).toContain('v2');
    expect(fs.readFileSync(
      path.join(agentWorkDir, '.agents/skills/nested-skill/references/guide.md'),
      'utf8',
    )).toBe('asset-v2');
  });

  it('removes exact plugin-owned copies while restoring explicit same-name precedence', () => {
    const pluginDir = path.join(tmpDir, 'source-plugin');
    const nestedSkillDir = path.join(pluginDir, 'skills', 'shared-skill');
    fs.mkdirSync(nestedSkillDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'SKILL.md'), '# Removed root plugin skill');
    fs.writeFileSync(path.join(nestedSkillDir, 'SKILL.md'), '# Plugin fallback');

    const explicitRoot = path.join(tmpDir, 'explicit-skills');
    fs.mkdirSync(path.join(explicitRoot, 'shared-skill', 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(explicitRoot, 'shared-skill', 'SKILL.md'),
      '# Explicit configured skill',
    );
    fs.writeFileSync(
      path.join(explicitRoot, 'shared-skill', 'assets', 'fixture.txt'),
      'explicit-asset',
    );

    const agentWorkDir = path.join(tmpDir, 'agent-workdir-cleanup');
    fs.mkdirSync(path.join(agentWorkDir, '.agents', 'skills', 'user-owned'), { recursive: true });
    fs.writeFileSync(
      path.join(agentWorkDir, '.agents', 'skills', 'user-owned', 'SKILL.md'),
      '# User authored',
    );
    const manager = new AgentManagerDb(tmpDir, {} as any, { libraryRoot: null });
    reconcile(manager, agentWorkDir, {
      plugins: [{ name: 'demo-plugin', path: pluginDir }],
    });
    reconcile(manager, agentWorkDir, {
      skills: ['shared-skill'],
      skillsRoot: explicitRoot,
    });

    expect(fs.existsSync(path.join(agentWorkDir, 'plugins', 'demo-plugin'))).toBe(false);
    expect(fs.readFileSync(
      path.join(agentWorkDir, '.agents/skills/shared-skill/SKILL.md'),
      'utf8',
    )).toContain('Explicit configured skill');
    expect(fs.readFileSync(
      path.join(agentWorkDir, '.agents/skills/shared-skill/assets/fixture.txt'),
      'utf8',
    )).toBe('explicit-asset');
    for (const root of ['.claude/skills', '.agents/skills', '.cursor/skills']) {
      expect(fs.readFileSync(
        path.join(agentWorkDir, root, 'shared-skill', 'SKILL.md'),
        'utf8',
      )).toContain('Explicit configured skill');
      expect(fs.readFileSync(
        path.join(agentWorkDir, root, 'shared-skill', 'assets', 'fixture.txt'),
        'utf8',
      )).toBe('explicit-asset');
    }
    expect(fs.readFileSync(
      path.join(agentWorkDir, '.agents/skills/user-owned/SKILL.md'),
      'utf8',
    )).toContain('User authored');
  });

  it('retains an unavailable optional skill while refreshing bundled framework skills', () => {
    const explicitRoot = path.join(tmpDir, 'explicit-skills');
    fs.mkdirSync(path.join(explicitRoot, 'brain'), { recursive: true });
    fs.writeFileSync(path.join(explicitRoot, 'brain', 'SKILL.md'), '# Current Brain skill');

    const agentWorkDir = path.join(tmpDir, 'agent-workdir-unavailable-skill');
    const unavailable = path.join(agentWorkDir, '.agents', 'skills', 'legacy-optional');
    fs.mkdirSync(unavailable, { recursive: true });
    fs.writeFileSync(path.join(unavailable, 'SKILL.md'), '# Preserved optional skill');

    const manager = new AgentManagerDb(tmpDir, {} as any, { libraryRoot: null });
    reconcile(manager, agentWorkDir, {
      skills: ['brain', 'legacy-optional'],
      skillsRoot: explicitRoot,
    });

    expect(fs.readFileSync(path.join(unavailable, 'SKILL.md'), 'utf8'))
      .toContain('Preserved optional skill');
    for (const root of ['.claude/skills', '.agents/skills', '.cursor/skills']) {
      expect(fs.readFileSync(
        path.join(agentWorkDir, root, 'brain', 'SKILL.md'),
        'utf8',
      )).toContain('Current Brain skill');
    }
  });

  it('transitions plugin fallback to bundled agent skill and back under one receipt', () => {
    const pluginDir = path.join(tmpDir, 'source-plugin');
    const pluginSkill = path.join(pluginDir, 'skills', 'shared-skill');
    fs.mkdirSync(pluginSkill, { recursive: true });
    fs.writeFileSync(path.join(pluginSkill, 'SKILL.md'), '# Plugin version');

    const libraryRoot = path.join(tmpDir, 'library');
    const agentEntry = path.join(libraryRoot, 'agents', 'bundled-agent');
    fs.mkdirSync(path.join(agentEntry, 'skills', 'shared-skill'), { recursive: true });
    fs.writeFileSync(path.join(agentEntry, 'CLAUDE.md'), '# Bundled persona');
    fs.writeFileSync(
      path.join(agentEntry, 'skills', 'shared-skill', 'SKILL.md'),
      '# Bundled agent version',
    );

    const agentWorkDir = path.join(tmpDir, 'agent-workdir-transition');
    const manager = new AgentManagerDb(tmpDir, {} as any, { libraryRoot });
    reconcile(manager, agentWorkDir, {
      plugins: [{ name: 'demo-plugin', path: pluginDir }],
    });
    expect(fs.readFileSync(
      path.join(agentWorkDir, '.agents/skills/shared-skill/SKILL.md'),
      'utf8',
    )).toContain('Plugin version');

    reconcile(manager, agentWorkDir, {
      plugins: [{ name: 'demo-plugin', path: pluginDir }],
      agentOverlay: 'bundled-agent',
    });
    expect(fs.readFileSync(
      path.join(agentWorkDir, '.agents/skills/shared-skill/SKILL.md'),
      'utf8',
    )).toContain('Bundled agent version');

    reconcile(manager, agentWorkDir, {
      plugins: [{ name: 'demo-plugin', path: pluginDir }],
    });
    expect(fs.readFileSync(
      path.join(agentWorkDir, '.agents/skills/shared-skill/SKILL.md'),
      'utf8',
    )).toContain('Plugin version');
    expect(fs.existsSync(
      path.join(agentWorkDir, '.idacc/plugin-materialization-v1.json'),
    )).toBe(false);
  });

  it('never adopts or deletes an agent-edited plugin across rebuild and ad-hoc reconcile', async () => {
    const pluginDir = path.join(tmpDir, 'external-source-plugin');
    const pluginSkill = path.join(pluginDir, 'skills', 'plugin-tool');
    fs.mkdirSync(pluginSkill, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), '{"version":1}\n');
    fs.writeFileSync(path.join(pluginDir, 'runtime.js'), 'managed-runtime\n');
    fs.writeFileSync(path.join(pluginSkill, 'SKILL.md'), '# Plugin tool\n');

    const explicitRoot = path.join(tmpDir, 'explicit-skills');
    fs.mkdirSync(path.join(explicitRoot, 'ad-hoc'), { recursive: true });
    fs.writeFileSync(
      path.join(explicitRoot, 'ad-hoc', 'SKILL.md'),
      '# Ad-hoc installed skill\n',
    );

    const agentWorkDir = path.join(tmpDir, 'agent-workdir-owned-plugin');
    const manager = new AgentManagerDb(tmpDir, {} as any, { libraryRoot: null });
    const materialized = reconcile(manager, agentWorkDir, {
      plugins: [{ name: 'demo-plugin', path: pluginDir }],
    });
    const persistedPlugins = materialized.localPlugins;
    const localPlugin = path.join(agentWorkDir, 'plugins', 'demo-plugin');
    const localManifest = path.join(localPlugin, 'plugin.json');
    fs.writeFileSync(localManifest, '{"version":"agent-owned-edit"}\n');

    // Rebuild consumes metadata.plugins, whose runtime path points at this
    // local materialization. It may project skills, but cannot claim its bytes.
    let rebuiltMetadata: Record<string, unknown> | undefined;
    (manager as any).db = {
      teams: {
        getConfig: async () => ({}),
      },
      agents: {
        updateMetadata: async (_agentId: string, metadata: Record<string, unknown>) => {
          rebuiltMetadata = metadata;
        },
      },
    };
    await (manager as any).refreshManagedOverlayForRebuild('team-id', 'team', {
      id: 'agent-id',
      name: 'worker',
      runtime: 'codex',
      working_directory: agentWorkDir,
      domain: null,
      metadata: {
        alias: 'worker',
        plugins: persistedPlugins,
        skills: [],
      },
    });
    expect(rebuiltMetadata?.plugins).toEqual(persistedPlugins);
    let receipt = JSON.parse(fs.readFileSync(
      path.join(agentWorkDir, '.id-agents/managed-overlay-receipt.json'),
      'utf8',
    ));
    expect(receipt.files['plugins/demo-plugin/plugin.json']).toBeUndefined();

    // The ad-hoc skill install path reconciles the same persisted plugin list.
    // A second pass proves the already released edit is never re-adopted.
    reconcile(manager, agentWorkDir, {
      plugins: rebuiltMetadata!.plugins,
      skills: ['ad-hoc'],
      skillsRoot: explicitRoot,
    });
    receipt = JSON.parse(fs.readFileSync(
      path.join(agentWorkDir, '.id-agents/managed-overlay-receipt.json'),
      'utf8',
    ));
    expect(receipt.files['plugins/demo-plugin/plugin.json']).toBeUndefined();

    const removed = reconcile(manager, agentWorkDir);
    expect(fs.readFileSync(localManifest, 'utf8')).toBe('{"version":"agent-owned-edit"}\n');
    expect(fs.existsSync(localPlugin)).toBe(true);
    expect(fs.existsSync(path.join(localPlugin, 'runtime.js'))).toBe(false);
    expect(removed.result.removed).toContain('plugins/demo-plugin/runtime.js');
    expect(removed.result.preserved).toContain('plugins/demo-plugin/');
    receipt = JSON.parse(fs.readFileSync(
      path.join(agentWorkDir, '.id-agents/managed-overlay-receipt.json'),
      'utf8',
    ));
    expect(receipt.files['plugins/demo-plugin/plugin.json']).toBeUndefined();
  });

  it('rejects Unicode-normalization aliases in the aggregate source plan before mutation', () => {
    const pluginDir = path.join(tmpDir, 'unicode-source-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'caf\u00e9.md'), 'composed');
    fs.writeFileSync(path.join(pluginDir, 'cafe\u0301.md'), 'decomposed');

    const agentWorkDir = path.join(tmpDir, 'agent-workdir-unicode');
    const manager = new AgentManagerDb(tmpDir, {} as any, { libraryRoot: null });
    expect(() => reconcile(manager, agentWorkDir, {
      plugins: [{ name: 'unicode-plugin', path: pluginDir }],
    })).toThrow(/printable ASCII/i);
    expect(fs.existsSync(path.join(agentWorkDir, 'plugins'))).toBe(false);
  });
});
