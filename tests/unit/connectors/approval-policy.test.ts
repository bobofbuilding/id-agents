// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { resolveApprovalMode } from '../../../src/connectors/policy/approval-policy.js';
import { GMAIL_V1_MANIFEST } from '../../../src/connectors/providers/gmail/gmail-manifest.js';
import type { ApprovalPolicyRecord, CapabilityManifestEntry } from '../../../src/connectors/types.js';

const searchCapability = GMAIL_V1_MANIFEST.capabilities.find((c) => c.id === 'gmail.messages.search')!;
const sendCapability = GMAIL_V1_MANIFEST.capabilities.find((c) => c.id === 'gmail.drafts.send')!;
const hardDenyCapability = GMAIL_V1_MANIFEST.capabilities.find((c) => c.id === 'gmail.messages.send')!;

function policy(overrides: Partial<ApprovalPolicyRecord> = {}): ApprovalPolicyRecord {
  return {
    id: 'policy-1',
    capabilityId: searchCapability.id,
    agentId: '*',
    tenantId: '*',
    mode: 'confirm',
    conditions: {},
    policyVersion: 1,
    createdAt: 0,
    ...overrides,
  };
}

describe('resolveApprovalMode', () => {
  it('uses the manifest floor when no policy row matches', () => {
    const result = resolveApprovalMode(searchCapability, 'agent-a', 'tenant-a', []);
    expect(result.mode).toBe('auto');
    expect(result.requiresApproval).toBe(false);
  });

  it('always resolves hardDeny capabilities to deny, ignoring any policy row', () => {
    const result = resolveApprovalMode(hardDenyCapability, 'agent-a', 'tenant-a', [
      policy({ capabilityId: hardDenyCapability.id, mode: 'auto' }),
    ]);
    expect(result.mode).toBe('deny');
    expect(result.requiresApproval).toBe(false);
  });

  it('a policy row can make an "auto" capability stricter', () => {
    const result = resolveApprovalMode(searchCapability, 'agent-a', 'tenant-a', [policy({ mode: 'confirm' })]);
    expect(result.mode).toBe('confirm');
    expect(result.requiresApproval).toBe(true);
  });

  it('a policy row cannot loosen "always" on a manifest-required capability', () => {
    const result = resolveApprovalMode(sendCapability, 'agent-a', 'tenant-a', [
      policy({ capabilityId: sendCapability.id, mode: 'auto' }),
    ]);
    expect(result.mode).toBe('always');
    expect(result.requiresApproval).toBe(true);
  });

  it('an exact agent+tenant policy row is preferred over a wildcard row', () => {
    const result = resolveApprovalMode(searchCapability, 'agent-a', 'tenant-a', [
      policy({ id: 'wildcard', agentId: '*', tenantId: '*', mode: 'confirm' }),
      policy({ id: 'exact', agentId: 'agent-a', tenantId: 'tenant-a', mode: 'always' }),
    ]);
    expect(result.mode).toBe('always');
    expect(result.matchedPolicy?.id).toBe('exact');
  });

  it('a condition-scoped policy only applies when the condition matches', () => {
    const externalOnly = policy({ mode: 'always', conditions: { externalRecipient: true } });
    const notExternal = resolveApprovalMode(searchCapability, 'agent-a', 'tenant-a', [externalOnly], {
      externalRecipient: false,
    });
    expect(notExternal.mode).toBe('auto');

    const isExternal = resolveApprovalMode(searchCapability, 'agent-a', 'tenant-a', [externalOnly], {
      externalRecipient: true,
    });
    expect(isExternal.mode).toBe('always');
  });
});
