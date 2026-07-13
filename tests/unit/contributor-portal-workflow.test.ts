// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import {
  ContributorChainRegistry,
  ContributorPortalWorkflow,
  ContributorSigningPolicyService,
  InMemoryAppendOnlyDecisionAuditLog,
  InMemoryNonceStore,
  canonicalContributorIntentHash,
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
const VALID_SIGNATURE = '0x923b35bfd34e685d28bbcdfbc735e5f2095a113c8f6331d7c3afc7e702f5823e70f22921bed6145e1a9c7ccce9ae3931105baf01681f795ae41cd0a403cc1aa51b' as Hex;

interface FixtureIdentityProof {
  domain: string;
  chain_id: number;
  org: string;
  agent_id: string;
  request_binding: string;
  proof_nonce: string;
  signature: Hex;
}

const INVALID_SIGNATURE = `${VALID_SIGNATURE.slice(0, -1)}c` as Hex;

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

function proofFor(
  intent: ContributorDecisionRequest,
  overrides: Partial<FixtureIdentityProof> = {},
): FixtureIdentityProof {
  return Object.freeze({
    domain: 'agent.bittrees.org',
    chain_id: 8453,
    org: intent.org,
    agent_id: intent.agent_id,
    request_binding: canonicalContributorIntentHash(intent),
    proof_nonce: `proof-${intent.request_id}`,
    signature: VALID_SIGNATURE,
    ...overrides,
  });
}

function harness(options: {
  consumedProofNonces?: Set<string>;
  policy?: ContributorSigningPolicyService;
} = {}) {
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
  const policy = options.policy ?? new ContributorSigningPolicyService(
    registry,
    authorities,
    delegations,
    new InMemoryNonceStore(),
    new InMemoryAppendOnlyDecisionAuditLog(),
    () => NOW,
  );
  const consumedProofNonces = options.consumedProofNonces ?? new Set<string>();
  const identities: PortalIdentityVerifier<FixtureIdentityProof> = {
    verify: vi.fn(async (proof, boundRequest) => {
      if (proof.domain !== 'agent.bittrees.org') return null;
      if (proof.chain_id !== 8453 || boundRequest.chain_id !== 8453) return null;
      if (proof.org !== boundRequest.org || proof.agent_id !== boundRequest.agent_id) return null;
      if (proof.request_binding !== canonicalContributorIntentHash(boundRequest)) return null;
      if (proof.signature !== VALID_SIGNATURE) return null;
      if (consumedProofNonces.has(proof.proof_nonce)) return null;
      consumedProofNonces.add(proof.proof_nonce);
      return caller;
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

    const outcome = await workflow.run({ identity: proofFor(intent), request: intent });

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
    ['invalid signature', { signature: INVALID_SIGNATURE }],
    ['wrong-domain proof', { domain: 'attacker.example' }],
    ['wrong-chain proof', { chain_id: 1 }],
  ])('fails closed for an %s', async (_label, proofOverrides) => {
    const { execute, workflow } = harness();
    const intent = request();

    const outcome = await workflow.run({ identity: proofFor(intent, proofOverrides), request: intent });

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
    const intent = request();
    vi.mocked(identities.verify).mockRejectedValueOnce(new Error('verification backend unavailable'));

    const outcome = await workflow.run({ identity: proofFor(intent), request: intent });

    expect(outcome).toEqual({ status: 'denied', reason: 'identity proof verification failed' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed when policy evaluation throws', async () => {
    const policy = { decide: vi.fn(() => { throw new Error('policy store unavailable'); }) } as unknown as ContributorSigningPolicyService;
    const { execute, workflow } = harness({ policy });
    const intent = request();

    const outcome = await workflow.run({ identity: proofFor(intent), request: intent });

    expect(outcome).toEqual({ status: 'denied', reason: 'authorization policy evaluation failed' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a denial when the bounded action dependency throws', async () => {
    const { execute, workflow } = harness();
    const intent = request();
    execute.mockRejectedValueOnce(new Error('executor unavailable'));

    const outcome = await workflow.run({ identity: proofFor(intent), request: intent });

    expect(outcome.status).toBe('denied');
    expect(outcome.reason).toBe('bounded action execution failed');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects a replayed request nonce before a second bounded action can execute', async () => {
    const { execute, workflow } = harness();
    const first = request();
    const second = request({ request_id: 'request-2' });

    expect((await workflow.run({ identity: proofFor(first), request: first })).status).toBe('executed');
    const replay = await workflow.run({
      identity: proofFor(second),
      request: second,
    });

    expect(replay.status).toBe('denied');
    expect(replay.reason).toBe('nonce already used');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects replayed identity proofs before authorization can execute again', async () => {
    const { execute, identities, workflow } = harness();
    const intent = request();
    const proof = proofFor(intent);

    expect((await workflow.run({ identity: proof, request: intent })).status).toBe('executed');
    const replay = await workflow.run({ identity: proof, request: intent });

    expect(replay).toEqual({ status: 'denied', reason: 'identity proof verification failed' });
    expect(identities.verify).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects durable identity-proof replay after a workflow restart', async () => {
    const durableProofNonces = new Set<string>();
    const intent = request();
    const first = harness({ consumedProofNonces: durableProofNonces });
    const restarted = harness({ consumedProofNonces: durableProofNonces });

    expect((await first.workflow.run({ identity: proofFor(intent), request: intent })).status).toBe('executed');
    const replayAfterRestart = await restarted.workflow.run({
      identity: proofFor(intent),
      request: intent,
    });

    expect(replayAfterRestart).toEqual({ status: 'denied', reason: 'identity proof verification failed' });
    expect(restarted.execute).not.toHaveBeenCalled();
  });

  it('fails closed when the identity proof is bound to a different request', async () => {
    const { execute, workflow } = harness();
    const issuedFor = request();
    const mutatedRequest = request({ request_id: 'request-mutated', payload_hash: 'sha256:mutated-payload' });

    const outcome = await workflow.run({ identity: proofFor(issuedFor), request: mutatedRequest });

    expect(outcome).toEqual({ status: 'denied', reason: 'identity proof verification failed' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed when the proof agent binding does not match the request', async () => {
    const { execute, workflow } = harness();
    const intent = request();

    const outcome = await workflow.run({
      identity: proofFor(intent, { agent_id: 'agent-8' }),
      request: intent,
    });

    expect(outcome).toEqual({ status: 'denied', reason: 'identity proof verification failed' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['domain organization', { org: 'bittrees-research' }],
    ['action', { action: 'admin' }],
    ['target', { target: 'gov.bittrees.org' }],
    ['chain', { chain_id: 1 }],
  ])('keeps a valid signer outside the intended %s scope from executing', async (_label, overrides) => {
    const { execute, workflow } = harness();
    const intent = request(overrides);

    const outcome = await workflow.run({ identity: proofFor(intent), request: intent });

    expect(outcome.status).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });
});
