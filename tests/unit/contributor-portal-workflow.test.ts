// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { verifyMessage, type Address, type Hex } from 'viem';
import {
  ContributorChainRegistry,
  ContributorPortalWorkflow,
  ContributorSigningPolicyService,
  InMemoryAppendOnlyDecisionAuditLog,
  InMemoryNonceStore,
  type AuthenticatedCaller,
  type AuthorityResolver,
  type ContributorDecisionRequest,
  type ContributorSigningConfig,
  type DelegationGrant,
  type DelegationStore,
  type PortalIdentityVerifier,
  type VerifiedAuthority,
} from '../../src/contributor-signing/index.js';

const NOW = 1_800_000_000_000;
const IDENTITY_MESSAGE = 'agent.bittrees.org|v1|chain:8453|org:bittrees-inc|agent:agent-7|nonce:identity-1';
const SIGNER_ADDRESS = '0xeaDAAf441aD287768805D509657C19AF819cc07C' as Address;
const VALID_SIGNATURE = '0x923b35bfd34e685d28bbcdfbc735e5f2095a113c8f6331d7c3afc7e702f5823e70f22921bed6145e1a9c7ccce9ae3931105baf01681f795ae41cd0a403cc1aa51b' as Hex;

interface FixtureIdentityProof {
  message: string;
  signature: Hex;
}

// Public address/signature fixtures contain no private key or signing capability.
const VALID_PROOF: FixtureIdentityProof = Object.freeze({
  message: IDENTITY_MESSAGE,
  signature: VALID_SIGNATURE,
});
const INVALID_PROOF: FixtureIdentityProof = Object.freeze({
  message: IDENTITY_MESSAGE,
  signature: `${VALID_SIGNATURE.slice(0, -1)}c` as Hex,
});
const DOMAIN_MISMATCH_PROOF: FixtureIdentityProof = Object.freeze({
  message: IDENTITY_MESSAGE.replace('agent.bittrees.org', 'attacker.example'),
  signature: VALID_SIGNATURE,
});

function config(): ContributorSigningConfig {
  return {
    enabled: true,
    registryVersion: 1,
    chains: [
      { chainId: 1, name: 'ethereum', rpcEnv: 'ETHEREUM_RPC_URL', scopes: ['identity'] },
      { chainId: 8453, name: 'base', rpcEnv: 'BASE_RPC_URL', scopes: ['identity', 'contributor', 'forum'] },
    ],
    policies: [{
      org: 'bittrees-inc',
      surface: 'contributor',
      action: 'apply',
      chainId: 8453,
      allowedTargets: ['bittrees-inc-contributor-registry'],
      allowedRoles: ['contributor'],
    }],
  };
}

function request(overrides: Partial<ContributorDecisionRequest> = {}): ContributorDecisionRequest {
  return {
    mode: 'decision',
    agent_id: 'agent-7',
    org: 'bittrees-inc',
    surface: 'contributor',
    action: 'apply',
    target: 'bittrees-inc-contributor-registry',
    chain_id: 8453,
    delegation_id: 'delegation-1',
    request_id: 'request-1',
    nonce: 'nonce-1',
    expiry: NOW + 30_000,
    payload_hash: 'sha256:deterministic-fixture-payload',
    ...overrides,
  };
}

function harness() {
  const caller: AuthenticatedCaller = {
    principal_id: 'session-agent-7',
    org: 'bittrees-inc',
  };
  const authority: VerifiedAuthority = {
    agent_id: 'agent-7',
    org: 'bittrees-inc',
    roles: ['contributor'],
    approver: 'idacc-policy',
    relayer: null,
  };
  const grant: DelegationGrant = {
    delegation_id: 'delegation-1',
    agent_id: 'agent-7',
    delegator: 'engineering-lead',
    org: 'bittrees-inc',
    surfaces: ['contributor'],
    actions: ['apply'],
    targets: ['bittrees-inc-contributor-registry'],
    chain_ids: [8453],
    expires_at: NOW + 60_000,
  };
  const authorities: AuthorityResolver = { resolve: resolved => resolved.principal_id === caller.principal_id ? authority : null };
  const delegations: DelegationStore = { get: id => id === grant.delegation_id ? grant : null };
  const registry = new ContributorChainRegistry(config(), {
    ETHEREUM_RPC_URL: 'http://127.0.0.1:8545',
    BASE_RPC_URL: 'http://127.0.0.1:8546',
  });
  const policy = new ContributorSigningPolicyService(
    registry,
    authorities,
    delegations,
    new InMemoryNonceStore(),
    new InMemoryAppendOnlyDecisionAuditLog(),
    () => NOW,
  );
  const identities: PortalIdentityVerifier<FixtureIdentityProof> = {
    verify: vi.fn(async proof => {
      if (proof.message !== IDENTITY_MESSAGE) return null;
      return await verifyMessage({
        address: SIGNER_ADDRESS,
        message: proof.message,
        signature: proof.signature,
      }) ? caller : null;
    }),
  };
  const execute = vi.fn(async () => ({ application_id: 'application-123' }));
  const workflow = new ContributorPortalWorkflow(identities, policy, execute);
  return { execute, identities, workflow };
}

describe('contributor portal signer workflow matrix', () => {
  it('executes only the configured bounded action for a valid identity and authorized intent', async () => {
    const { execute, workflow } = harness();
    const intent = request();

    const outcome = await workflow.run({ identity: VALID_PROOF, request: intent });

    expect(outcome.status).toBe('executed');
    expect(outcome.decision.decision).toBe('approved');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'apply', target: 'bittrees-inc-contributor-registry', chain_id: 8453 }),
      expect.objectContaining({ decision: 'approved' }),
    );
    expect(execute.mock.calls[0][0]).not.toBe(intent);
    expect(Object.isFrozen(execute.mock.calls[0][0])).toBe(true);
  });

  it.each([
    ['invalid signature', INVALID_PROOF],
    ['domain-mismatched signature', DOMAIN_MISMATCH_PROOF],
  ])('fails closed for an %s', async (_label, identity) => {
    const { execute, workflow } = harness();

    const outcome = await workflow.run({ identity, request: request() });

    expect(outcome).toEqual({ status: 'denied', reason: 'identity proof verification failed' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed without calling the verifier when identity is absent', async () => {
    const { execute, identities, workflow } = harness();

    const outcome = await workflow.run({ request: request() });

    expect(outcome).toEqual({ status: 'denied', reason: 'identity proof is required' });
    expect(identities.verify).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed when identity verification throws', async () => {
    const { execute, identities, workflow } = harness();
    vi.mocked(identities.verify).mockRejectedValueOnce(new Error('verification backend unavailable'));

    const outcome = await workflow.run({ identity: VALID_PROOF, request: request() });

    expect(outcome).toEqual({ status: 'denied', reason: 'identity proof verification failed' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a replayed nonce before a second bounded action can execute', async () => {
    const { execute, workflow } = harness();

    expect((await workflow.run({ identity: VALID_PROOF, request: request() })).status).toBe('executed');
    const replay = await workflow.run({
      identity: VALID_PROOF,
      request: request({ request_id: 'request-2' }),
    });

    expect(replay.status).toBe('denied');
    expect(replay.reason).toBe('nonce already used');
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    ['domain organization', { org: 'bittrees-research' }],
    ['action', { action: 'admin' }],
    ['target', { target: 'gov.bittrees.org' }],
    ['chain', { chain_id: 1 }],
  ])('keeps a valid signer outside the intended %s scope from executing', async (_label, overrides) => {
    const { execute, workflow } = harness();

    const outcome = await workflow.run({ identity: VALID_PROOF, request: request(overrides) });

    expect(outcome.status).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });
});
