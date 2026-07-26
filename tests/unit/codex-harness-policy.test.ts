// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  codexPermissionArgs,
  codexReasoningEffort,
  codexStdinInvocation,
  resolveCodexExecutable,
} from '../../src/harness/codex.js';

describe('Codex harness permission policy', () => {
  it('uses read-only sandbox config for control-plane prompts', () => {
    expect(codexPermissionArgs({
      skipPermissions: true,
      executionPolicy: 'control-plane-readonly',
    })).toEqual({
      args: ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'],
      label: 'read-only control-plane sandbox',
    });
  });

  it('keeps full bypass for normal autonomous work when configured', () => {
    expect(codexPermissionArgs({ skipPermissions: true })).toEqual({
      args: ['--dangerously-bypass-approvals-and-sandbox'],
      label: '--dangerously-bypass-approvals-and-sandbox (default)',
    });
  });

  it('maps unsupported minimal effort to low for tool-capable Codex runs', () => {
    expect(codexReasoningEffort('minimal')).toBe('low');
    expect(codexReasoningEffort('low')).toBe('low');
    expect(codexReasoningEffort('medium')).toBe('medium');
    expect(codexReasoningEffort('high')).toBe('high');
    expect(codexReasoningEffort('xhigh')).toBe('high');
    expect(codexReasoningEffort('invalid')).toBeUndefined();
  });

  it('delivers complete prompts only over the existing stdin sentinel', () => {
    const prompt = 'private prompt\n$(cat /shared/secret) & echo should-not-run';
    const invocation = codexStdinInvocation(['exec', '--json'], prompt);

    expect(invocation.args).toEqual(['exec', '--json', '-']);
    expect(invocation.args).not.toContain(prompt);
    expect(invocation.stdin).toBe(prompt);
  });

  it('keeps prompts off argv when a Windows .cmd launcher is selected', () => {
    const prompt = 'private prompt with %TOKEN% & shell metacharacters';
    const executable = resolveCodexExecutable(
      { ID_AGENT_CODEX_BIN: 'C:\\Users\\consumer\\AppData\\Roaming\\npm\\codex.cmd' },
      'win32',
    );
    const invocation = codexStdinInvocation(['exec', '--json'], prompt);

    expect(executable.command).toMatch(/codex\.cmd$/i);
    expect(invocation.args).not.toContain(prompt);
    expect(invocation.stdin).toBe(prompt);
  });

  it('does not write full prompts to predictable shared temp files', () => {
    const source = readFileSync(new URL('../../src/harness/codex.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('codex-prompt-');
    expect(source).not.toContain('writeFileSync(promptFile');
    expect(source).not.toContain('Prompt written to temp file');
    expect(source).toContain('portableSpawn(codexExecutable.command, invocation.args');
  });
});
