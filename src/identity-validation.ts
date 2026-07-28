// SPDX-License-Identifier: MIT

import { namehash, normalize } from 'viem/ens';

export const ENS_TOKEN_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface NormalizedEnsIdentity {
  domain?: string;
  tokenId?: string;
}

export interface CompleteEnsIdentity {
  domain: string;
  tokenId: string;
}

/**
 * Validate and canonicalize an ENS identity declaration. A domain and token
 * may be omitted independently for legacy retention semantics, but whenever
 * both are supplied the token must be the exact ENS namehash.
 */
export function normalizeEnsIdentity(
  domainValue: unknown,
  tokenIdValue: unknown,
): NormalizedEnsIdentity {
  let domain: string | undefined;
  if (domainValue !== undefined && domainValue !== null) {
    if (typeof domainValue !== 'string' || !domainValue.trim()) {
      throw new Error('domain must be a non-empty ENS name');
    }
    try {
      domain = normalize(domainValue.trim());
    } catch {
      throw new Error('domain must be a valid ENS name');
    }
    if (!domain || domain.length > 255) {
      throw new Error('domain must be a valid ENS name');
    }
  }

  let tokenId: string | undefined;
  if (tokenIdValue !== undefined && tokenIdValue !== null) {
    if (
      typeof tokenIdValue !== 'string'
      || !ENS_TOKEN_ID_PATTERN.test(tokenIdValue)
    ) {
      throw new Error('tokenId must be 0x followed by exactly 64 hexadecimal characters');
    }
    tokenId = tokenIdValue.toLowerCase();
  }

  if (domain && tokenId) {
    const expected = namehash(domain).toLowerCase();
    if (tokenId !== expected) {
      throw new Error(`tokenId must equal the ENS namehash of "${domain}"`);
    }
  }
  return {
    ...(domain && { domain }),
    ...(tokenId && { tokenId }),
  };
}

/**
 * Produce the complete canonical identity for a domain. Registration flows use
 * this rather than provider-specific labels so the durable token is always the
 * ENS namehash of the canonical domain.
 */
export function ensIdentityForDomain(domainValue: unknown): CompleteEnsIdentity {
  const { domain } = normalizeEnsIdentity(domainValue, undefined);
  if (!domain) {
    throw new Error('domain must be a non-empty ENS name');
  }
  return {
    domain,
    tokenId: namehash(domain).toLowerCase(),
  };
}
