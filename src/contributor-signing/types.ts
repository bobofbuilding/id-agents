// SPDX-License-Identifier: MIT

export const BASE_CHAIN_ID = 8453;
export const ETHEREUM_CHAIN_ID = 1;

export interface ContributorChainConfig {
  chainId: number;
  name: string;
  /** Environment-variable name. Raw RPC URLs are deliberately not config fields. */
  rpcEnv: string;
  /** Existing non-contributor scopes remain available on their configured chains. */
  scopes: string[];
}
export interface ContributorActionPolicyConfig {
  org: string;
  surface: string;
  action: string;
  chainId: number;
  allowedTargets: string[];
  allowedRoles: string[];
}

export interface ContributorSigningConfig {
  /** Safe rollout default: policy decisions fail closed until explicitly enabled. */
  enabled: boolean;
  registryVersion: number;
  chains: ContributorChainConfig[];
  policies: ContributorActionPolicyConfig[];
}

export interface ContributorIntent {
  agent_id: string;
  org: string;
  surface: string;
  action: string;
  target: string;
  chain_id: number;
  delegation_id: string;
  request_id: string;
  nonce: string;
  expiry: number;
  /** Hash of calldata or another canonical application payload. */
  payload_hash: string;
}

export interface ContributorDecisionRequest extends ContributorIntent {
  mode: 'decision' | 'view';
  /** Optional client echo. A mismatch is denied; the server always recomputes it. */
  canonical_intent_hash?: string;
}

export interface AuthenticatedCaller {
  principal_id: string;
  org: string;
  /** Untrusted client claims are checked against server-resolved roles, never used directly. */
  claimed_role?: string;
}

export interface VerifiedAuthority {
  agent_id: string;
  org: string;
  roles: string[];
  approver: string;
  relayer: string | null;
}

export interface AuthorityResolver {
  resolve(caller: AuthenticatedCaller): VerifiedAuthority | null;
}

export interface DelegationGrant {
  delegation_id: string;
  agent_id: string;
  delegator: string;
  org: string;
  surfaces: string[];
  actions: string[];
  targets: string[];
  chain_ids: number[];
  expires_at: number;
  revoked?: boolean;
}

export interface DelegationStore {
  get(delegationId: string): DelegationGrant | null;
}

export interface NonceStore {
  /** Atomically consume a nonce. Returns false when it was already consumed. */
  consume(delegationId: string, nonce: string): boolean;
}

export type ContributorDecision = 'approved' | 'denied';

/**
 * Stable, snake_case decision schema for an append-only audit stream.
 * Nullable attribution fields stay present even on fail-closed denials.
 */
export interface ContributorDecisionRecord {
  agent_id: string;
  org: string;
  surface: string;
  action: string;
  target: string;
  chain_id: number;
  delegation_id: string;
  delegator: string | null;
  request_id: string;
  canonical_intent_hash: string;
  nonce: string;
  expiry: number;
  decision: ContributorDecision;
  approver: string | null;
  relayer: string | null;
  reason: string;
}

export interface AuditEnvelope {
  sequence: number;
  recorded_at: string;
  previous_hash: string | null;
  entry_hash: string;
  record: ContributorDecisionRecord;
}

export interface DecisionAuditLog {
  append(record: ContributorDecisionRecord): AuditEnvelope;
}
