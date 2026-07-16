// SPDX-License-Identifier: MIT
/**
 * Pure approval-policy evaluation. A capability's manifest approval mode is
 * the floor; an ApprovalPolicyRecord may only make it stricter, never
 * looser — a capability manifested as "always" cannot be downgraded to
 * "auto" by a policy row. This keeps external-recipient/attachment
 * conditions from silently weakening a hard requirement.
 */

import type { ApprovalMode, ApprovalPolicyRecord, CapabilityManifestEntry } from '../types.js';

const APPROVAL_STRICTNESS: Record<ApprovalMode, number> = {
  auto: 0,
  confirm: 1,
  always: 2,
  deny: 3,
};

export interface ApprovalContext {
  externalRecipient?: boolean;
  hasAttachment?: boolean;
}

export interface ApprovalDecisionResult {
  mode: ApprovalMode;
  requiresApproval: boolean;
  matchedPolicy?: ApprovalPolicyRecord;
}

function stricter(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return APPROVAL_STRICTNESS[a] >= APPROVAL_STRICTNESS[b] ? a : b;
}

/**
 * Resolve the effective approval mode for one invocation: start from the
 * manifest floor, then apply the most specific matching policy row (exact
 * agent+tenant beats wildcard), only if it is at least as strict.
 * `hardDeny` capabilities always resolve to "deny" regardless of policy rows.
 */
export function resolveApprovalMode(
  capability: CapabilityManifestEntry,
  agentId: string,
  tenantId: string,
  policies: ApprovalPolicyRecord[],
  context: ApprovalContext = {},
): ApprovalDecisionResult {
  if (capability.hardDeny) return { mode: 'deny', requiresApproval: false };

  const specificity = (p: ApprovalPolicyRecord): number =>
    (p.agentId === agentId ? 2 : 0) + (p.tenantId === tenantId ? 1 : 0);

  const candidates = policies
    .filter((p) => p.capabilityId === capability.id)
    .filter((p) => p.agentId === agentId || p.agentId === '*')
    .filter((p) => p.tenantId === tenantId || p.tenantId === '*')
    .filter((p) => {
      if (p.conditions.externalRecipient != null && p.conditions.externalRecipient !== !!context.externalRecipient) {
        return false;
      }
      if (p.conditions.hasAttachment != null && p.conditions.hasAttachment !== !!context.hasAttachment) {
        return false;
      }
      return true;
    });

  let effective: ApprovalMode = capability.approval;
  let matched: ApprovalPolicyRecord | undefined;

  if (candidates.length > 0) {
    // Only the most specific group (exact agent+tenant beats wildcard) is
    // considered; a less-specific policy row can't dilute a more specific
    // one. Within that group, the strictest mode wins.
    const maxSpecificity = Math.max(...candidates.map(specificity));
    const topGroup = candidates.filter((p) => specificity(p) === maxSpecificity);
    matched = topGroup.reduce((strictest, p) =>
      APPROVAL_STRICTNESS[p.mode] > APPROVAL_STRICTNESS[strictest.mode] ? p : strictest,
    );
    effective = stricter(effective, matched.mode);
  }

  return {
    mode: effective,
    requiresApproval: effective === 'confirm' || effective === 'always',
    matchedPolicy: matched,
  };
}
