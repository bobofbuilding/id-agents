// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';

describe('plugin skill fallback deployment', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-plugin-fallback-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mirrors plugin skills into every local runtime skill folder', () => {
    const pluginDir = path.join(tmpDir, 'source-plugin');
    const nestedSkillDir = path.join(pluginDir, 'skills', 'nested-skill');
    fs.mkdirSync(nestedSkillDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'SKILL.md'), '# Root plugin skill');
    fs.writeFileSync(path.join(nestedSkillDir, 'SKILL.md'), '# Nested plugin skill');

    const agentWorkDir = path.join(tmpDir, 'agent-workdir');
    fs.mkdirSync(agentWorkDir, { recursive: true });
    const manager = new AgentManagerDb(tmpDir, {} as any, { libraryRoot: null }) as any;

    const copied = manager.copyPluginsToAgent([{ name: 'demo-plugin', path: pluginDir }], agentWorkDir);

    expect(copied).toEqual([{ name: 'demo-plugin', path: path.join(agentWorkDir, 'plugins', 'demo-plugin') }]);
    for (const root of ['.claude/skills', '.agents/skills', '.cursor/skills']) {
      expect(fs.readFileSync(path.join(agentWorkDir, root, 'demo-plugin', 'SKILL.md'), 'utf8')).toContain('Root plugin skill');
      expect(fs.readFileSync(path.join(agentWorkDir, root, 'nested-skill', 'SKILL.md'), 'utf8')).toContain('Nested plugin skill');
    }
  });
});
