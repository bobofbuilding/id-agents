// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  executableCandidatePaths,
  executableExtensions,
  executableRequiresShell,
  resolveExecutable,
} from '../../src/lib/executable-resolution.js';

describe('cross-platform executable resolution', () => {
  it('uses Windows PATHEXT and the Windows PATH delimiter', () => {
    const env = {
      Path: '"C:\\Program Files\\IDACC";C:\\Users\\consumer\\AppData\\Roaming\\npm',
      PATHEXT: '.EXE;.CMD',
    };
    const resolved = resolveExecutable('claude', {
      env,
      platform: 'win32',
      isExecutable: (candidate) => candidate === 'C:\\Users\\consumer\\AppData\\Roaming\\npm\\claude.cmd',
    });

    expect(executableExtensions('win32', env.PATHEXT)).toEqual(['.exe', '.cmd']);
    expect(resolved).toBe('C:\\Users\\consumer\\AppData\\Roaming\\npm\\claude.cmd');
    expect(executableRequiresShell(resolved!, 'win32')).toBe(true);
  });

  it('does not append Windows extensions on POSIX', () => {
    expect(executableCandidatePaths('/usr/local/bin', 'codex', {
      platform: 'linux',
      env: { PATH: '/usr/local/bin:/usr/bin' },
    })).toEqual(['/usr/local/bin/codex']);
    expect(executableRequiresShell('/usr/local/bin/codex', 'linux')).toBe(false);
  });

  it('keeps Manager preflight on the shared resolver and .cmd-aware launcher', () => {
    const registry = readFileSync(new URL('../../src/runtime/registry.ts', import.meta.url), 'utf8');
    expect(registry).toContain('resolveExecutable(override || command)');
    expect(registry).toContain('portableSpawnSync(executable, args');
    expect(registry).not.toContain('execFileSync(command');
    expect(registry).not.toContain('shell: true');
  });

  it('routes every managed subscription harness through the same portable launcher', () => {
    for (const file of [
      'claude-code-cli.ts',
      'codex.ts',
      'cursor-cli.ts',
      'grok.ts',
      'antigravity.ts',
      'copilot-cli.ts',
      'kiro-cli.ts',
      'kimi-cli.ts',
    ]) {
      const source = readFileSync(new URL(`../../src/harness/${file}`, import.meta.url), 'utf8');
      expect(source, file).toContain('portableSpawn');
      expect(source, file).not.toContain('shell: true');
    }
  });
});
