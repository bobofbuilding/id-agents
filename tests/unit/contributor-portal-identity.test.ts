// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverMessageAddress, verifyMessage, type Address, type Hex } from 'viem';
import {
  ContributorChainRegistry,
  ContributorPortalWorkflow,
  ContributorSigningPolicyService,
  InMemoryAppendOnlyDecisionAuditLog,
  PORTAL_WALLET_IDENTITY_DOMAIN,
  PORTAL_WALLET_IDENTITY_SCHEME,
  SqliteNonceStore,
  StaticPortalWalletIdentityBindingResolver,
  ViemPortalWalletIdentityVerifier,
  buildPortalWalletIdentityMessage,
  type AuthenticatedCaller,
  type AuthorityResolver,
  type ContributorDecisionRequest,
  type ContributorSigningConfig,
  type DelegationGrant,
  type DelegationStore,
  type PortalWalletIdentityBinding,
  type PortalWalletIdentityProof,
  type VerifiedAuthority,
} from '../../src/contributor-signing/index.js';

const NOW = 1_800_000_000_000;
// Public signature fixture only. Its address is recovered from the canonical
// message below, so this test contains no private key or signing capability.
const PUBLIC_SIGNATURE = '0x923b35bfd34e685d28bbcdfbc735e5f2095a113c8f6331d7c3afc7e702f5823e70f22921bed6145e1a9c7ccce9ae3931105baf01681f795ae41cd0a403cc1aa51b' as Hex;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

const proof: PortalWalletIdentityProof = Object.freeze({
  scheme: PORTAL_WALLET_IDENTITY_SCHEME,
  domain: PORTAL_WALLET_IDENTITY_DOMAIN,
  signature: PUBLIC_SIGNATURE,
});

async function publicAddressFor(intent: ContributorDecisionRequest): Promise<Address> {
  return recoverMessageAddress({
    message: buildPortalWalletIdentityMessage(intent),
    signature: PUBLIC_SIGNATURE,
  });
}

function binding(intent: ContributorDecisionRequest, walletAddress: Address): PortalWalletIdentityBinding {
  return {
    agent_id: intent.agent_id,
    org: intent.org,
    chain_id: intent.chain_id,
    wallet_address: walletAddress,
    principal_id: 'session-agent-7',
  };
}

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

function policy(nonces: SqliteNonceStore): ContributorSigningPolicyService {
  const caller: AuthenticatedCaller = { principal_id: 'session-agent-7', org: 'bittrees-inc' };
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
  const authorities: AuthorityResolver = {
    resolve: resolved => resolved.principal_id === caller.principal_id ? authority : null,
  };
  const delegations: DelegationStore = { get: id => id === grant.delegation_id ? grant : null };
  const registry = new ContributorChainRegistry(config(), {
    ETHEREUM_RPC_URL: 'http://127.0.0.1:8545',
    BASE_RPC_URL: 'http://127.0.0.1:8546',
  });
  return new ContributorSigningPolicyService(
    registry,
    authorities,
    delegations,
    nonces,
    new InMemoryAppendOnlyDecisionAuditLog(),
    () => NOW,
  );
}

async function workflow(dbFile: string) {
  const intent = request();
  const address = await publicAddressFor(intent);
  const identities = new ViemPortalWalletIdentityVerifier(
    new StaticPortalWalletIdentityBindingResolver([binding(intent, address)]),
  );
  const nonces = new SqliteNonceStore(dbFile);
  const execute = vi.fn(async () => ({ application_id: 'application-123' }));
  return {
    execute,
    identities,
    nonces,
    workflow: new ContributorPortalWorkflow(identities, policy(nonces), execute),
  };
}

function temporaryDatabase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idacc-portal-nonce-'));
  tmpDirs.push(dir);
  return path.join(dir, 'nonces.sqlite');
}

describe('production portal wallet identity and nonce boundary', () => {
  it('accepts the valid public proof and rejects invalid, validly signed wrong-domain, wrong-binding, and mutated-request proofs', async () => {
    const issuedFor = request();
    const expectedAddress = await publicAddressFor(issuedFor);
    const wrongAgent = request({ agent_id: 'agent-8' });
    const resolver = new StaticPortalWalletIdentityBindingResolver([
      binding(issuedFor, expectedAddress),
      binding(wrongAgent, expectedAddress),
    ]);
    const verifier = new ViemPortalWalletIdentityVerifier(resolver);

    await expect(verifier.verify(proof, issuedFor)).resolves.toEqual({
      principal_id: 'session-agent-7',
      org: 'bittrees-inc',
    });
    await expect(verifier.verify({ ...proof, signature: `${PUBLIC_SIGNATURE.slice(0, -2)}1c` as Hex }, issuedFor)).resolves.toBeNull();
    await expect(verifier.verify(proof, wrongAgent)).resolves.toBeNull();
    await expect(verifier.verify(proof, request({ request_id: 'request-mutated', payload_hash: 'sha256:mutated' }))).resolves.toBeNull();

    const wrongDomain = 'attacker.example';
    const wrongDomainMessage = buildPortalWalletIdentityMessage(issuedFor, wrongDomain);
    const wrongDomainAddress = await recoverMessageAddress({ message: wrongDomainMessage, signature: PUBLIC_SIGNATURE });
    await expect(verifyMessage({
      address: wrongDomainAddress,
      message: wrongDomainMessage,
      signature: PUBLIC_SIGNATURE,
    })).resolves.toBe(true);
    const wrongDomainVerifier = new ViemPortalWalletIdentityVerifier(
      new StaticPortalWalletIdentityBindingResolver([binding(issuedFor, wrongDomainAddress)]),
    );
    await expect(wrongDomainVerifier.verify({ ...proof, domain: wrongDomain }, issuedFor)).resolves.toBeNull();

    const wrongWalletVerifier = new ViemPortalWalletIdentityVerifier(
      new StaticPortalWalletIdentityBindingResolver([
        binding(issuedFor, '0x0000000000000000000000000000000000000001'),
      ]),
    );
    await expect(wrongWalletVerifier.verify(proof, issuedFor)).resolves.toBeNull();
  });

  it('fails closed for a validly signed wrong-chain request', async () => {
    const wrongChain = request({ chain_id: 1 });
    const wrongChainAddress = await publicAddressFor(wrongChain);
    const identities = new ViemPortalWalletIdentityVerifier(
      new StaticPortalWalletIdentityBindingResolver([binding(wrongChain, wrongChainAddress)]),
    );
    await expect(identities.verify(proof, wrongChain)).resolves.toEqual({
      principal_id: 'session-agent-7',
      org: 'bittrees-inc',
    });

    const nonces = new SqliteNonceStore(temporaryDatabase());
    const execute = vi.fn(async () => ({ application_id: 'application-123' }));
    const gated = new ContributorPortalWorkflow(identities, policy(nonces), execute);
    try {
      await expect(gated.run({ identity: proof, request: wrongChain })).resolves.toMatchObject({
        status: 'denied',
        reason: expect.stringContaining('Base chain 8453'),
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      nonces.close();
    }
  });

  it('fails closed for an absent proof and executes a valid proof only once', async () => {
    const dbFile = temporaryDatabase();
    const harness = await workflow(dbFile);
    const verify = vi.spyOn(harness.identities, 'verify');
    try {
      await expect(harness.workflow.run({ request: request() })).resolves.toEqual({
        status: 'denied',
        reason: 'identity proof is required',
      });
      expect(verify).not.toHaveBeenCalled();

      await expect(harness.workflow.run({ identity: proof, request: request() })).resolves.toMatchObject({
        status: 'executed',
      });
      await expect(harness.workflow.run({ identity: proof, request: request() })).resolves.toMatchObject({
        status: 'denied',
        reason: 'nonce already used',
      });
      expect(harness.execute).toHaveBeenCalledOnce();
    } finally {
      harness.nonces.close();
    }
  });

  it('rejects the same proof after the durable nonce store is recreated', async () => {
    const dbFile = temporaryDatabase();
    const first = await workflow(dbFile);
    try {
      await expect(first.workflow.run({ identity: proof, request: request() })).resolves.toMatchObject({
        status: 'executed',
      });
      expect(first.execute).toHaveBeenCalledOnce();
    } finally {
      first.nonces.close();
    }

    const recreated = await workflow(dbFile);
    try {
      await expect(recreated.workflow.run({ identity: proof, request: request() })).resolves.toMatchObject({
        status: 'denied',
        reason: 'nonce already used',
      });
      expect(recreated.execute).not.toHaveBeenCalled();
    } finally {
      recreated.nonces.close();
    }
  });
});
