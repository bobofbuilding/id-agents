// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { codexPermissionArgs, codexReasoningEffort } from '../../src/harness/codex.js';

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
});
