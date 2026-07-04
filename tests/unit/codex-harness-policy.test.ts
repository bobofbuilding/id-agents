// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { codexPermissionArgs } from '../../src/harness/codex.js';

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
});
