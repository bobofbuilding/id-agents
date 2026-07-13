// SPDX-License-Identifier: MIT
/**
 * ENS Primary-Naming Guard
 *
 * Fail-closed gate for the "primary/reverse ENS record" leg of agent
 * provisioning. `id-cli` only wraps forward registration (register,
 * set-agent-endpoints, set-record/set-addr, info); it has no command for
 * the ENS Reverse Registrar's setName(), and this codebase has no direct
 * RPC/signer client for raw contract writes — every onchain write goes
 * through the `id-cli`/`ows` CLI wrapper (see src/onchain/idchain-register.ts,
 * docs/reference/architecture.md). Bolting on a new signer path for one
 * missing call is out of scope for this guard.
 *
 * Instead, this module verifies what can be verified today (read-only
 * forward resolution) and keeps identity_primary_status in a durable
 * pending/blocked state until real forward+reverse proof exists.
 * `evaluatePrimaryNameGate` is the only function allowed to decide
 * identity_primary_status; callers must persist its receipt as-is.
 */

import { getAgentInfo } from './idchain-register.js';

export type IdentityPrimaryStatus = 'pending' | 'verified' | 'blocked';

export interface PrimaryNameReceipt {
  domain: string;
  walletAddress: string;
  status: IdentityPrimaryStatus;
  forwardVerified: boolean;
  reverseVerified: boolean;
  spendCapWei: string | null;
  reason: string;
  checkedAt: string;
}

const ENV_SPEND_CAP = 'ENS_PRIMARY_SPEND_CAP_WEI';

/**
 * Fail-closed spend-cap read: missing, non-numeric, or <= 0 all resolve to
 * "no cap configured". There is no unlimited/default-allow path.
 */
export function getConfiguredSpendCapWei(env: NodeJS.ProcessEnv = process.env): bigint | null {
  const raw = env[ENV_SPEND_CAP];
  if (!raw) return null;
  try {
    const value = BigInt(raw);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

export function isSpendCapConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getConfiguredSpendCapWei(env) !== null;
}

type GetAgentInfoFn = (opts: { name: string }) => Promise<any>;

function extractAddressRecord(info: any): string | null {
  if (!info) return null;
  if (typeof info.address === 'string') return info.address;
  if (typeof info.addr === 'string') return info.addr;
  const records = info.records || info.addresses;
  if (Array.isArray(records)) {
    const evm = records.find(
      (r: any) => r?.coinType === 2147483648 || r?.coinType === '2147483648' || r?.key === 'eip155:1' || r?.chain === 'EVM',
    );
    const value = evm?.value || evm?.address;
    if (typeof value === 'string') return value;
  }
  return null;
}

/**
 * Read-only check that the ENS name's forward address record resolves to
 * the wallet address the agent was provisioned with. Never signs or spends.
 */
export async function verifyForwardRecord(opts: {
  name: string;
  expectedAddress: string;
  getAgentInfoFn?: GetAgentInfoFn;
}): Promise<boolean> {
  const getInfo = opts.getAgentInfoFn ?? getAgentInfo;
  try {
    const info = await getInfo({ name: opts.name });
    const resolved = extractAddressRecord(info);
    return !!resolved && resolved.toLowerCase() === opts.expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * There is no id-cli command and no direct ENS ReverseRegistrar client in
 * this codebase to set or verify the reverse record. This function is the
 * single place that decides reverse-record status; it must only ever
 * return `verified: true` once a real onchain reverse-resolution check is
 * wired in — never inferred from forward-record success.
 */
export async function verifyReverseRecord(_opts: {
  walletAddress: string;
  expectedName: string;
}): Promise<{ verified: boolean; reason: string }> {
  return {
    verified: false,
    reason:
      'no-reverse-registrar-tooling: id-cli exposes no set-primary-name/reverse-record command and no direct ENS ReverseRegistrar signer is wired into this codebase',
  };
}

/**
 * Run the full bidirectional check and produce a durable receipt.
 * identity_primary_status must always come from this function's output,
 * never be set to 'verified' by any other code path.
 */
export async function evaluatePrimaryNameGate(opts: {
  domain: string;
  walletAddress: string | null | undefined;
  env?: NodeJS.ProcessEnv;
  getAgentInfoFn?: GetAgentInfoFn;
}): Promise<PrimaryNameReceipt> {
  const checkedAt = new Date().toISOString();
  const spendCap = getConfiguredSpendCapWei(opts.env ?? process.env);
  const spendCapWei = spendCap !== null ? spendCap.toString() : null;

  if (!opts.walletAddress) {
    return {
      domain: opts.domain,
      walletAddress: '',
      status: 'blocked',
      forwardVerified: false,
      reverseVerified: false,
      spendCapWei,
      reason: 'no-wallet: agent has no OWS wallet address, forward/reverse records cannot be attributed to it',
      checkedAt,
    };
  }

  const forwardVerified = await verifyForwardRecord({
    name: opts.domain,
    expectedAddress: opts.walletAddress,
    getAgentInfoFn: opts.getAgentInfoFn,
  });

  const reverse = await verifyReverseRecord({
    walletAddress: opts.walletAddress,
    expectedName: opts.domain,
  });

  let status: IdentityPrimaryStatus;
  let reason: string;

  if (!forwardVerified) {
    status = 'blocked';
    reason = 'forward-record-unverified: ENS name does not resolve to the agent wallet address';
  } else if (!reverse.verified) {
    status = 'pending';
    reason = reverse.reason;
  } else if (spendCap === null) {
    // Defense in depth for when reverse tooling lands: a spend cap must be
    // an explicit operator decision, never an inferred default, even if
    // both directions verify.
    status = 'blocked';
    reason = `spend-cap-not-configured: set ${ENV_SPEND_CAP} before primary-name can be marked verified`;
  } else {
    status = 'verified';
    reason = 'forward and reverse records verified within configured spend cap';
  }

  return {
    domain: opts.domain,
    walletAddress: opts.walletAddress,
    status,
    forwardVerified,
    reverseVerified: reverse.verified,
    spendCapWei,
    reason,
    checkedAt,
  };
}
