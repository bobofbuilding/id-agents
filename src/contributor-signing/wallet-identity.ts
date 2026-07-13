// SPDX-License-Identifier: MIT

import { getAddress, verifyMessage, type Address, type Hex } from 'viem';
import { canonicalContributorIntentHash } from './policy-service.js';
import type { AuthenticatedCaller, ContributorDecisionRequest } from './types.js';
import type { PortalIdentityVerifier } from './portal-workflow.js';

export const PORTAL_WALLET_IDENTITY_SCHEMA = 'bittrees.contributor.wallet-identity.v1' as const;
export const PORTAL_WALLET_IDENTITY_DOMAIN = 'agent.bittrees.org' as const;
export const PORTAL_WALLET_IDENTITY_SCHEME = 'eip191-v1' as const;

/**
 * A client-held wallet signs the message built by
 * `buildPortalWalletIdentityMessage`. The portal accepts only the signature
 * and public protocol selectors; it never accepts a private key, mnemonic, or
 * signing callback.
 */
export interface PortalWalletIdentityProof {
  scheme: typeof PORTAL_WALLET_IDENTITY_SCHEME;
  domain: string;
  signature: Hex;
}

/** Server-owned wallet-to-agent binding. Never populate this from request data. */
export interface PortalWalletIdentityBinding {
  agent_id: string;
  org: string;
  chain_id: number;
  wallet_address: Address;
  principal_id: string;
  claimed_role?: string;
}

export interface PortalWalletIdentityBindingResolver {
  resolve(input: Readonly<{
    agent_id: string;
    org: string;
    chain_id: number;
  }>): PortalWalletIdentityBinding | null | Promise<PortalWalletIdentityBinding | null>;
}

function bindingKey(agentId: string, org: string, chainId: number): string {
  return `${agentId}\u0000${org}\u0000${chainId}`;
}

/**
 * Concrete resolver for server-loaded configuration and tests. Constructor
 * input is trusted application configuration, not a client identity claim.
 */
export class StaticPortalWalletIdentityBindingResolver implements PortalWalletIdentityBindingResolver {
  private readonly bindings = new Map<string, PortalWalletIdentityBinding>();

  constructor(bindings: readonly PortalWalletIdentityBinding[]) {
    for (const binding of bindings) {
      if (!binding.agent_id || !binding.org || !binding.principal_id || !Number.isInteger(binding.chain_id)) {
        throw new Error('portal wallet identity binding is incomplete');
      }
      const normalized = Object.freeze({
        ...binding,
        wallet_address: getAddress(binding.wallet_address),
      });
      const key = bindingKey(normalized.agent_id, normalized.org, normalized.chain_id);
      if (this.bindings.has(key)) throw new Error('duplicate portal wallet identity binding');
      this.bindings.set(key, normalized);
    }
  }

  resolve(input: Readonly<{ agent_id: string; org: string; chain_id: number }>): PortalWalletIdentityBinding | null {
    return this.bindings.get(bindingKey(input.agent_id, input.org, input.chain_id)) ?? null;
  }
}

/**
 * Canonical, request-bound EIP-191 message. Every field that can change the
 * authorized effect is signed; the server recomputes the intent hash rather
 * than trusting the optional client echo.
 */
export function buildPortalWalletIdentityMessage(
  request: Readonly<ContributorDecisionRequest>,
  domain: string = PORTAL_WALLET_IDENTITY_DOMAIN,
): string {
  return JSON.stringify({
    schema: PORTAL_WALLET_IDENTITY_SCHEMA,
    domain,
    mode: request.mode,
    agent_id: request.agent_id,
    org: request.org,
    surface: request.surface,
    action: request.action,
    target: request.target,
    chain_id: request.chain_id,
    delegation_id: request.delegation_id,
    request_id: request.request_id,
    nonce: request.nonce,
    expiry: request.expiry,
    payload_hash: request.payload_hash,
    canonical_intent_hash: canonicalContributorIntentHash(request),
  });
}

/**
 * Production verification adapter. It recovers no client-selected identity:
 * the expected address and caller principal come exclusively from the
 * server-owned binding resolver.
 */
export class ViemPortalWalletIdentityVerifier implements PortalIdentityVerifier<PortalWalletIdentityProof> {
  constructor(
    private readonly bindings: PortalWalletIdentityBindingResolver,
    private readonly domain: string = PORTAL_WALLET_IDENTITY_DOMAIN,
  ) {
    if (!domain) throw new Error('portal wallet identity domain is required');
  }

  async verify(
    proof: PortalWalletIdentityProof,
    request: Readonly<ContributorDecisionRequest>,
  ): Promise<AuthenticatedCaller | null> {
    if (!proof || proof.scheme !== PORTAL_WALLET_IDENTITY_SCHEME || proof.domain !== this.domain) return null;
    if (typeof proof.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(proof.signature)) return null;

    try {
      const binding = await this.bindings.resolve({
        agent_id: request.agent_id,
        org: request.org,
        chain_id: request.chain_id,
      });
      if (!binding || binding.agent_id !== request.agent_id || binding.org !== request.org ||
          binding.chain_id !== request.chain_id || !binding.principal_id) {
        return null;
      }
      const valid = await verifyMessage({
        address: getAddress(binding.wallet_address),
        message: buildPortalWalletIdentityMessage(request, this.domain),
        signature: proof.signature,
      });
      if (!valid) return null;
      return Object.freeze({
        principal_id: binding.principal_id,
        org: binding.org,
        ...(binding.claimed_role ? { claimed_role: binding.claimed_role } : {}),
      });
    } catch {
      return null;
    }
  }
}
