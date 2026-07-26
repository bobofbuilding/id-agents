// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentManagerDb } from '../../src/agent-manager-db.js';

const ENV_KEYS = [
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'CLAUDE_PATH',
  'ID_AGENT_CODEX_BIN',
  'CODEX_BIN',
  'CODEX_EXECUTABLE',
  'SQLITE_PATH',
  'DATABASE_URL',
  'ID_WORKSPACE_DIR',
  'WORKSPACE_DIR',
] as const;

describe('Manager worker environment portability', () => {
  const workDirs: string[] = [];
  const originals = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originals.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originals.clear();
    for (const dir of workDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves Windows runtime variables and desktop-resolved CLI paths', () => {
    const values: Record<(typeof ENV_KEYS)[number], string> = {
      APPDATA: 'C:\\Users\\consumer\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\consumer\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\consumer',
      TEMP: 'C:\\Users\\consumer\\AppData\\Local\\Temp',
      TMP: 'C:\\Users\\consumer\\AppData\\Local\\Temp',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      CLAUDE_PATH: 'C:\\Users\\consumer\\AppData\\Roaming\\npm\\claude.cmd',
      ID_AGENT_CODEX_BIN: 'C:\\Users\\consumer\\AppData\\Roaming\\npm\\codex.cmd',
      CODEX_BIN: 'C:\\standalone\\codex-bin.cmd',
      CODEX_EXECUTABLE: 'C:\\standalone\\codex-executable.cmd',
      SQLITE_PATH: 'C:\\Users\\consumer\\AppData\\Roaming\\IDACC\\profiles\\default\\manager.sqlite',
      DATABASE_URL: 'postgresql://manager.example/idagents',
      ID_WORKSPACE_DIR: 'C:\\Users\\consumer\\AppData\\Roaming\\IDACC\\profiles\\default\\workspace',
      WORKSPACE_DIR: 'C:\\legacy-workspace-that-must-not-win',
    };
    for (const key of ENV_KEYS) {
      originals.set(key, process.env[key]);
      process.env[key] = values[key];
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-worker-env-'));
    workDirs.push(workDir);
    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;
    const env = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43123,
      { runtime: 'claude-code-cli', metadata: {} },
    );

    for (const key of ENV_KEYS) {
      if (key === 'SQLITE_PATH' || key === 'WORKSPACE_DIR') {
        expect(env[key]).toBeUndefined();
      } else {
        expect(env[key]).toBe(values[key]);
      }
    }
  });

  it('hands profile workers SQLite and the fallback workspace only without higher-precedence settings', () => {
    for (const key of ENV_KEYS) {
      originals.set(key, process.env[key]);
    }
    process.env.SQLITE_PATH = '/profiles/default/manager/id-agents.db';
    delete process.env.DATABASE_URL;
    delete process.env.ID_WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = '/profiles/default/workspace';

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-worker-db-env-'));
    workDirs.push(workDir);
    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;
    const env = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43124,
      { runtime: 'codex', metadata: {} },
    );

    expect(env.SQLITE_PATH).toBe('/profiles/default/manager/id-agents.db');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ID_WORKSPACE_DIR).toBe('/profiles/default/workspace');
    expect(env.WORKSPACE_DIR).toBeUndefined();
  });

  it('pins output speed for Claude Code workers without leaking it to unsupported runtimes', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-worker-speed-env-'));
    workDirs.push(workDir);
    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;

    const defaultClaude = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43125,
      { runtime: 'claude-code-cli', metadata: {} },
    );
    const fastClaude = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43126,
      { runtime: 'claude-code-local', metadata: { speed: 'fast' } },
    );
    const invalidClaude = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43127,
      { runtime: 'claude-code-cli', metadata: { speed: 'turbo' } },
    );
    const codex = manager.buildLocalAgentEnv(
      'team-id',
      'default',
      43128,
      { runtime: 'codex', metadata: { speed: 'fast' } },
    );

    expect(defaultClaude.ID_AGENT_SPEED).toBe('default');
    expect(fastClaude.ID_AGENT_SPEED).toBe('fast');
    expect(invalidClaude.ID_AGENT_SPEED).toBe('default');
    expect(codex.ID_AGENT_SPEED).toBeUndefined();
  });
});
