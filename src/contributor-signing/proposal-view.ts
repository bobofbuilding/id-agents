// SPDX-License-Identifier: MIT

/**
 * This module intentionally imports no wallet, signer, contract, transport, or
 * relayer capability. It converts inert proposal data into inert display data.
 */
export interface RenderOnlyContributorProposal {
  kind: 'contributor-proposal';
  effect: 'render-only';
  proposal_id: string;
  org: string;
  surface: string;
  action: string;
  target: string;
  chain_id: number;
  canonical_intent_hash: string;
  expires_at: number;
  summary: string;
}
export interface RenderedContributorProposal {
  readonly kind: 'contributor-proposal-view';
  readonly effect: 'none';
  readonly fields: ReadonlyArray<Readonly<{ label: string; value: string }>>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`proposal ${key} is required`);
  return value;
}

export function renderContributorProposal(input: unknown): RenderedContributorProposal {
  if (!input || typeof input !== 'object') throw new Error('proposal must be an object');
  const proposal = input as Record<string, unknown>;
  if (proposal.kind !== 'contributor-proposal' || proposal.effect !== 'render-only') {
    throw new Error('only render-only contributor proposals may be viewed');
  }
  if (!Number.isInteger(proposal.chain_id) || Number(proposal.chain_id) <= 0) {
    throw new Error('proposal chain_id must be a positive integer');
  }
  if (!Number.isFinite(proposal.expires_at)) throw new Error('proposal expires_at is required');

  const fields = [
    { label: 'Proposal', value: requiredString(proposal, 'proposal_id') },
    { label: 'Organization', value: requiredString(proposal, 'org') },
    { label: 'Surface', value: requiredString(proposal, 'surface') },
    { label: 'Action', value: requiredString(proposal, 'action') },
    { label: 'Target', value: requiredString(proposal, 'target') },
    { label: 'Chain', value: String(proposal.chain_id) },
    { label: 'Intent hash', value: requiredString(proposal, 'canonical_intent_hash') },
    { label: 'Expires', value: new Date(Number(proposal.expires_at)).toISOString() },
    { label: 'Summary', value: requiredString(proposal, 'summary') },
  ].map(field => Object.freeze(field));

  return Object.freeze({ kind: 'contributor-proposal-view', effect: 'none', fields: Object.freeze(fields) });
}
