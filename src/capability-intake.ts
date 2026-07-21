// SPDX-License-Identifier: MIT

import crypto from 'crypto';

export function buildCapabilityIntakeRecord(input: {
  kind: 'skill' | 'plugin' | 'mcp';
  name: string;
  source: string;
  content: string;
  owner: string;
  runtime: string;
  permissions?: string[];
  cost?: string;
  health?: string;
  nowMs?: number;
}): Record<string, unknown> {
  const nowMs = input.nowMs ?? Date.now();
  const permissions = [...new Set((input.permissions?.length ? input.permissions : ['read workspace context', 'return model guidance']).map(String).filter(Boolean))];
  const blockers = [
    !input.source && 'missing_provenance',
    !input.content.trim() && 'empty_capability',
    !input.owner && 'missing_owner',
    !input.runtime && 'missing_runtime_compatibility',
    !permissions.length && 'missing_permissions',
  ].filter(Boolean);
  return {
    version: 'capability-intake.v1',
    kind: input.kind,
    name: input.name,
    provenance: {
      source: input.source,
      sha256: crypto.createHash('sha256').update(input.content).digest('hex'),
    },
    permissions,
    cost: input.cost || 'runtime-dependent',
    health: input.health || 'source-present',
    compatibility: { runtime: input.runtime },
    owner: input.owner,
    rollback: input.kind === 'skill' ? 'POST /library/skills/uninstall' : 'detach and rebuild affected agents',
    reviewed_at: nowMs,
    re_evaluate_at: nowMs + 90 * 24 * 60 * 60 * 1000,
    status: blockers.length ? 'blocked' : 'approved',
    blockers,
  };
}
