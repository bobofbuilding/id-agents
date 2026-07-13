// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  evaluatePrimaryNameGate,
  getConfiguredSpendCapWei,
  isSpendCapConfigured,
  verifyForwardRecord,
  verifyReverseRecord,
} from '../../src/onchain/ens-primary-guard.js';

describe('ens-primary-guard: spend cap gate', () => {
  it('treats a missing env var as no cap configured', () => {
    expect(getConfiguredSpendCapWei({})).toBeNull();
    expect(isSpendCapConfigured({})).toBe(false);
  });

  it('treats zero, negative, and non-numeric values as no cap configured (fail closed)', () => {
    expect(getConfiguredSpendCapWei({ ENS_PRIMARY_SPEND_CAP_WEI: '0' })).toBeNull();
    expect(getConfiguredSpendCapWei({ ENS_PRIMARY_SPEND_CAP_WEI: '-1' })).toBeNull();
    expect(getConfiguredSpendCapWei({ ENS_PRIMARY_SPEND_CAP_WEI: 'not-a-number' })).toBeNull();
  });

  it('accepts a configured positive numeric cap', () => {
    expect(getConfiguredSpendCapWei({ ENS_PRIMARY_SPEND_CAP_WEI: '5000000000000000' })).toBe(
      5000000000000000n,
    );
    expect(isSpendCapConfigured({ ENS_PRIMARY_SPEND_CAP_WEI: '1' })).toBe(true);
  });
});

describe('ens-primary-guard: verifyForwardRecord', () => {
  it('matches when the resolved address equals the expected wallet address (case-insensitive)', async () => {
    const ok = await verifyForwardRecord({
      name: 'x.agent-9.xid.eth',
      expectedAddress: '0xABCDEF0000000000000000000000000000AB12',
      getAgentInfoFn: async () => ({ address: '0xabcdef0000000000000000000000000000ab12' }),
    });
    expect(ok).toBe(true);
  });

  it('fails closed when the resolved address does not match', async () => {
    const ok = await verifyForwardRecord({
      name: 'x.agent-9.xid.eth',
      expectedAddress: '0xAAAA',
      getAgentInfoFn: async () => ({ address: '0xBBBB' }),
    });
    expect(ok).toBe(false);
  });

  it('fails closed when the lookup throws', async () => {
    const ok = await verifyForwardRecord({
      name: 'x.agent-9.xid.eth',
      expectedAddress: '0xAAAA',
      getAgentInfoFn: async () => {
        throw new Error('id-cli not installed');
      },
    });
    expect(ok).toBe(false);
  });

  it('fails closed when no address record is present', async () => {
    const ok = await verifyForwardRecord({
      name: 'x.agent-9.xid.eth',
      expectedAddress: '0xAAAA',
      getAgentInfoFn: async () => ({}),
    });
    expect(ok).toBe(false);
  });
});

describe('ens-primary-guard: verifyReverseRecord', () => {
  it('never reports verified — no reverse-registrar tooling exists in this codebase', async () => {
    const result = await verifyReverseRecord({ walletAddress: '0xAAAA', expectedName: 'x.agent-9.xid.eth' });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/no-reverse-registrar-tooling/);
  });
});

describe('ens-primary-guard: evaluatePrimaryNameGate (identity_primary_status state machine)', () => {
  it('blocks when the agent has no wallet address to attribute records to', async () => {
    const receipt = await evaluatePrimaryNameGate({
      domain: 'x.agent-9.xid.eth',
      walletAddress: null,
      env: {},
    });
    expect(receipt.status).toBe('blocked');
    expect(receipt.reason).toMatch(/no-wallet/);
    expect(receipt.forwardVerified).toBe(false);
    expect(receipt.reverseVerified).toBe(false);
  });

  it('blocks when the forward record does not resolve to the wallet address', async () => {
    const receipt = await evaluatePrimaryNameGate({
      domain: 'x.agent-9.xid.eth',
      walletAddress: '0xAAAA',
      env: { ENS_PRIMARY_SPEND_CAP_WEI: '1000' },
      getAgentInfoFn: async () => ({ address: '0xFFFF' }),
    });
    expect(receipt.status).toBe('blocked');
    expect(receipt.forwardVerified).toBe(false);
    expect(receipt.reason).toMatch(/forward-record-unverified/);
  });

  it('never reaches verified today: forward-only proof lands in pending, spend cap or not', async () => {
    const withoutCap = await evaluatePrimaryNameGate({
      domain: 'x.agent-9.xid.eth',
      walletAddress: '0xAAAA',
      env: {},
      getAgentInfoFn: async () => ({ address: '0xAAAA' }),
    });
    expect(withoutCap.status).toBe('pending');
    expect(withoutCap.forwardVerified).toBe(true);
    expect(withoutCap.reverseVerified).toBe(false);
    expect(withoutCap.spendCapWei).toBeNull();

    const withCap = await evaluatePrimaryNameGate({
      domain: 'x.agent-9.xid.eth',
      walletAddress: '0xAAAA',
      env: { ENS_PRIMARY_SPEND_CAP_WEI: '1000' },
      getAgentInfoFn: async () => ({ address: '0xAAAA' }),
    });
    expect(withCap.status).toBe('pending');
    expect(withCap.spendCapWei).toBe('1000');
  });

  it('produces a receipt with a checkedAt timestamp for every evaluation', async () => {
    const receipt = await evaluatePrimaryNameGate({
      domain: 'x.agent-9.xid.eth',
      walletAddress: null,
      env: {},
    });
    expect(() => new Date(receipt.checkedAt).toISOString()).not.toThrow();
  });
});
