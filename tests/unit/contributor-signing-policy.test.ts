// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContributorChainRegistry,
  ContributorSigningPolicyService,
  InMemoryAppendOnlyDecisionAuditLog,
  InMemoryNonceStore,
  JsonlAppendOnlyDecisionAuditLog,
  canonicalContributorIntentHash,
  renderContributorProposal,
  validateContributorSigningConfig,
  type AuthenticatedCaller,
  type AuthorityResolver,
  type ContributorDecisionRequest,
  type ContributorSigningConfig,
  type DelegationGrant,
  type DelegationStore,
  type VerifiedAuthority,
} from '../../src/contributor-signing/index.js';

const NOW = 1_800_000_000_000;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function config(enabled = true): ContributorSigningConfig {
  return {
    enabled,
    registryVersion: 1,
    chains: [
      { chainId: 1, name: 'ethereum', rpcEnv: 'ETHEREUM_RPC_URL', scopes: ['identity', 'registry'] },
      { chainId: 8453, name: 'base', rpcEnv: 'BASE_RPC_URL', scopes: ['identity', 'registry', 'contributor', 'forum'] },
      { chainId: 10, name: 'optimism', rpcEnv: 'OPTIMISM_RPC_URL', scopes: ['analytics'] },
    ],
    policies: [
      {
        org: 'bittrees-inc',
        surface: 'contributor',
        action: 'apply',
        chainId: 8453,
        allowedTargets: ['bittrees-inc-contributor-registry'],
        allowedRoles: ['contributor'],
      },
      {
        org: 'bittrees-inc',
        surface: 'forum',
        action: 'post',
        chainId: 8453,
        allowedTargets: ['gov.bittrees.org'],
        allowedRoles: ['contributor', 'moderator'],
      },
    ],
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
    payload_hash: 'sha256:payload',
    ...overrides,
  };
}

const caller: AuthenticatedCaller = { principal_id: 'session-agent-7', org: 'bittrees-inc' };

function harness(options: {
  enabled?: boolean;
  authority?: VerifiedAuthority | null;
  grant?: Partial<DelegationGrant> | null;
} = {}) {
  const authority: VerifiedAuthority | null = options.authority === undefined ? {
    agent_id: 'agent-7',
    org: 'bittrees-inc',
    roles: ['contributor'],
    approver: 'idacc-policy',
    relayer: null,
  } : options.authority;
  const defaultGrant: DelegationGrant = {
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
  const grant = options.grant === null ? null : { ...defaultGrant, ...options.grant };
  const authorities: AuthorityResolver = { resolve: () => authority };
  const delegations: DelegationStore = { get: id => grant?.delegation_id === id ? grant : null };
  const audit = new InMemoryAppendOnlyDecisionAuditLog();
  const registry = new ContributorChainRegistry(config(options.enabled ?? true), {
    ETHEREUM_RPC_URL: 'http://127.0.0.1:8545',
    BASE_RPC_URL: 'http://127.0.0.1:8546',
    OPTIMISM_RPC_URL: 'http://127.0.0.1:8547',
  });
  return {
    audit,
    registry,
    service: new ContributorSigningPolicyService(registry, authorities, delegations, new InMemoryNonceStore(), audit, () => NOW),
  };
}

describe('config-driven contributor chain registry', () => {
  it('retains Ethereum and other configured chains for existing scopes while enforcing Base', () => {
    const { registry } = harness();

    expect(registry.resolveRpc(1, 'identity')).toBe('http://127.0.0.1:8545');
    expect(registry.resolveRpc(10, 'analytics')).toBe('http://127.0.0.1:8547');
    expect(() => registry.resolveRpc(1, 'contributor')).toThrow('not configured for contributor');
    expect(() => registry.assertActionChain('bittrees-inc', 'contributor', 'apply', 1)).toThrow('Base chain 8453');
  });

  it('rejects a config that routes contributor actions away from Base', () => {
    const invalid = config();
    invalid.policies[0].chainId = 1;
    invalid.chains[0].scopes.push('contributor');

    expect(validateContributorSigningConfig(invalid).map(issue => issue.message)).toEqual(expect.arrayContaining([
      'contributor actions are Base-only',
      'contributor actions must use Base chain 8453',
    ]));
  });

  it('fails closed when a scoped RPC environment variable is absent', () => {
    const registry = new ContributorChainRegistry(config(), { BASE_RPC_URL: 'http://127.0.0.1:8546' });

    expect(() => registry.resolveRpc(1, 'identity')).toThrow('ETHEREUM_RPC_URL is not set');
  });

  it('reports malformed chain entries without throwing during config validation', () => {
    const invalid = config() as ContributorSigningConfig & { chains: Array<ContributorSigningConfig['chains'][number] | null> };
    invalid.chains = [null, ...invalid.chains];

    expect(() => validateContributorSigningConfig(invalid as ContributorSigningConfig)).not.toThrow();
    expect(validateContributorSigningConfig(invalid as ContributorSigningConfig)).toContainEqual({
      path: 'contributorSigning.chains[0]',
      message: 'chain must be an object',
    });
  });
});

describe('contributor signing policy decision boundary', () => {
  it('approves a correctly scoped Base request and emits the complete decision schema', () => {
    const { service, audit } = harness();
    const input = request();
    input.canonical_intent_hash = canonicalContributorIntentHash(input);

    const result = service.decide(input, caller);

    expect(result).toEqual({
      agent_id: 'agent-7',
      org: 'bittrees-inc',
      surface: 'contributor',
      action: 'apply',
      target: 'bittrees-inc-contributor-registry',
      chain_id: 8453,
      delegation_id: 'delegation-1',
      delegator: 'engineering-lead',
      request_id: 'request-1',
      canonical_intent_hash: input.canonical_intent_hash,
      nonce: 'nonce-1',
      expiry: NOW + 30_000,
      decision: 'approved',
      approver: 'idacc-policy',
      relayer: null,
      reason: 'policy and delegation checks passed',
    });
    expect(audit.entries()).toHaveLength(1);
  });

  it('rejects the wrong chain even when a delegation mentions it', () => {
    const { service } = harness({ grant: { chain_ids: [1, 8453] } });

    const result = service.decide(request({ chain_id: 1 }), caller);

    expect(result.decision).toBe('denied');
    expect(result.reason).toContain('Base chain 8453');
  });

  it('rejects a spoofed client role instead of trusting it', () => {
    const { service } = harness();

    const result = service.decide(request(), { ...caller, claimed_role: 'moderator' });

    expect(result.decision).toBe('denied');
    expect(result.reason).toBe('claimed role is not server verified');
  });

  it('rejects nonce reuse and writes both decisions to the audit stream', () => {
    const { service, audit } = harness();

    expect(service.decide(request(), caller).decision).toBe('approved');
    const replay = service.decide(request({ request_id: 'request-2' }), caller);

    expect(replay.decision).toBe('denied');
    expect(replay.reason).toBe('nonce already used');
    expect(audit.entries()).toHaveLength(2);
    expect(audit.entries()[1].previous_hash).toBe(audit.entries()[0].entry_hash);
  });

  it.each([
    ['organization', { org: 'bittrees-research' }, 'authenticated principal or organization mismatch'],
    ['action', { action: 'admin' }, 'no matching org/surface/action policy'],
    ['target', { target: 'research.bittrees.org' }, 'target is not allowed for org/surface/action'],
  ])('rejects cross-scope %s confusion', (_label, overrides, reason) => {
    const { service } = harness();

    const result = service.decide(request(overrides), caller);

    expect(result.decision).toBe('denied');
    expect(result.reason).toBe(reason);
  });

  it('rejects canonical-intent mutation, expired delegation, and disabled policy by default', () => {
    expect(harness().service.decide(request({ canonical_intent_hash: 'sha256:spoofed' }), caller).reason)
      .toBe('canonical intent hash mismatch');
    expect(harness({ grant: { expires_at: NOW - 1 } }).service.decide(request(), caller).reason)
      .toBe('delegation expired or intent exceeds delegation expiry');
    expect(harness({ enabled: false }).service.decide(request(), caller).reason)
      .toBe('contributor signing is disabled');
  });
});

describe('render-only proposal boundary', () => {
  it('renders inert data without reading or calling injected signer-shaped properties', () => {
    const execute = vi.fn();
    let signerRead = false;
    const proposal = {
      kind: 'contributor-proposal',
      effect: 'render-only',
      proposal_id: 'proposal-1',
      org: 'bittrees-inc',
      surface: 'contributor',
      action: 'apply',
      target: 'bittrees-inc-contributor-registry',
      chain_id: 8453,
      canonical_intent_hash: 'sha256:intent',
      expires_at: NOW + 10_000,
      summary: 'Apply as a contributor',
      execute,
      get signer() {
        signerRead = true;
        throw new Error('signer must never be read');
      },
    };

    const rendered = renderContributorProposal(proposal);

    expect(rendered.effect).toBe('none');
    expect(execute).not.toHaveBeenCalled();
    expect(signerRead).toBe(false);
    expect(JSON.stringify(rendered)).not.toMatch(/execute|signer|writeContract|sendTransaction|signTypedData/);
  });

  it('cannot turn a view request into an authorization decision', () => {
    const { service } = harness();

    const result = service.decide(request({ mode: 'view' }), caller);

    expect(result.decision).toBe('denied');
    expect(result.reason).toBe('view requests cannot authorize execution');
  });
});

describe('append-only decision log', () => {
  it('persists hash-linked JSONL and detects tampering on reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idacc-contributor-audit-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'decisions.jsonl');
    const memory = harness().service.decide(request(), caller);
    const writer = new JsonlAppendOnlyDecisionAuditLog(file);
    writer.append(memory);
    writer.append({ ...memory, request_id: 'request-2', nonce: 'nonce-2' });

    expect(() => new JsonlAppendOnlyDecisionAuditLog(file)).not.toThrow();
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0]);
    first.record.reason = 'tampered';
    lines[0] = JSON.stringify(first);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    expect(() => new JsonlAppendOnlyDecisionAuditLog(file)).toThrow('integrity failure at sequence 1');
  });
});
