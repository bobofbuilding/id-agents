// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { evaluateGrant } from '../../../src/connectors/grants/grant-evaluator.js';
import type { CapabilityGrantRecord } from '../../../src/connectors/types.js';

const NOW = 1_000_000;

function makeGrant(overrides: Partial<CapabilityGrantRecord> = {}): CapabilityGrantRecord {
  return {
    id: 'grant-1',
    agentId: 'agent-a',
    tenantId: 'tenant-a',
    connectionId: 'conn-1',
    capabilityId: 'gmail.messages.search',
    connectorVersion: '1.0.0',
    effect: 'allow',
    resourceScope: {},
    grantVersion: 1,
    issuedBy: 'operator-1',
    reason: 'pilot',
    expiresAt: null,
    revokedAt: null,
    createdAt: NOW - 1000,
    ...overrides,
  };
}

const baseInput = {
  agentId: 'agent-a',
  tenantId: 'tenant-a',
  capabilityId: 'gmail.messages.search',
  connectionId: 'conn-1',
  now: NOW,
};

describe('evaluateGrant', () => {
  it('denies when there is no grant at all', () => {
    const result = evaluateGrant({ ...baseInput, candidateGrants: [] });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe('no_grant');
  });

  it('allows on an active, unscoped allow grant', () => {
    const result = evaluateGrant({ ...baseInput, candidateGrants: [makeGrant()] });
    expect(result.allowed).toBe(true);
    expect(result.matchedGrant?.id).toBe('grant-1');
  });

  it('deny-overrides-allow: a deny grant wins even if an allow grant also matches', () => {
    const grants = [makeGrant({ id: 'allow-1', effect: 'allow' }), makeGrant({ id: 'deny-1', effect: 'deny' })];
    const result = evaluateGrant({ ...baseInput, candidateGrants: grants });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe('grant_denied');
    expect(result.matchedGrant?.id).toBe('deny-1');
  });

  it('denies an expired grant', () => {
    const result = evaluateGrant({
      ...baseInput,
      candidateGrants: [makeGrant({ expiresAt: NOW - 1 })],
    });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe('grant_expired');
  });

  it('denies a revoked grant even if not yet expired', () => {
    const result = evaluateGrant({
      ...baseInput,
      candidateGrants: [makeGrant({ revokedAt: NOW - 1, expiresAt: NOW + 10_000 })],
    });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe('grant_revoked');
  });

  it('allows a grant that has not yet expired', () => {
    const result = evaluateGrant({
      ...baseInput,
      candidateGrants: [makeGrant({ expiresAt: NOW + 10_000 })],
    });
    expect(result.allowed).toBe(true);
  });

  it('ignores grants for a different agent/tenant/connection/capability', () => {
    const grants = [
      makeGrant({ agentId: 'agent-other' }),
      makeGrant({ tenantId: 'tenant-other' }),
      makeGrant({ connectionId: 'conn-other' }),
      makeGrant({ capabilityId: 'gmail.drafts.send' }),
    ];
    const result = evaluateGrant({ ...baseInput, candidateGrants: grants });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe('no_grant');
  });

  it('denies when the requested resource is outside the grant scope', () => {
    const result = evaluateGrant({
      ...baseInput,
      candidateGrants: [makeGrant({ resourceScope: { accountRef: 'mailbox-a' } })],
      requestedResource: { accountRef: 'mailbox-b' },
    });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe('resource_scope_violation');
  });

  it('denies a scoped grant when the invocation omits proof for that scope', () => {
    const result = evaluateGrant({
      ...baseInput,
      candidateGrants: [makeGrant({ resourceScope: { recipientDomainsAllow: ['example.com'] } })],
    });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe('resource_scope_violation');
  });

  it('allows when the requested resource matches the grant scope', () => {
    const result = evaluateGrant({
      ...baseInput,
      candidateGrants: [makeGrant({ resourceScope: { accountRef: 'mailbox-a' } })],
      requestedResource: { accountRef: 'mailbox-a' },
    });
    expect(result.allowed).toBe(true);
  });

  it('requires every requested recipient domain to be in the grant allow-list', () => {
    const allowed = evaluateGrant({
      ...baseInput,
      candidateGrants: [makeGrant({ resourceScope: { recipientDomainsAllow: ['example.com', 'bittrees.org'] } })],
      requestedResource: { recipientDomains: ['example.com', 'bittrees.org'] },
    });
    expect(allowed.allowed).toBe(true);

    const denied = evaluateGrant({
      ...baseInput,
      candidateGrants: [makeGrant({ resourceScope: { recipientDomainsAllow: ['example.com'] } })],
      requestedResource: { recipientDomains: ['example.com', 'outside.test'] },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.denyCode).toBe('resource_scope_violation');
  });

  it('enforces maxResults grant caps when present', () => {
    const allowed = evaluateGrant({
      ...baseInput,
      candidateGrants: [makeGrant({ resourceScope: { maxResults: 10 } })],
      requestedResource: { maxResults: 10 },
    });
    expect(allowed.allowed).toBe(true);

    const denied = evaluateGrant({
      ...baseInput,
      candidateGrants: [makeGrant({ resourceScope: { maxResults: 10 } })],
      requestedResource: { maxResults: 11 },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.denyCode).toBe('resource_scope_violation');
  });
});
