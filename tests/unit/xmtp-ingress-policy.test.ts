// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  MAX_XMTP_MESSAGE_BYTES,
  MAX_XMTP_TRACKED_SENDERS,
  MAX_XMTP_TURNS_GLOBAL,
  MAX_XMTP_TURNS_PER_SENDER,
  XMTP_INGRESS_WINDOW_MS,
  XmtpIngressPolicy,
} from '../../src/xmtp/ingress-policy.js';

describe('XMTP inbound resource policy', () => {
  it('rejects oversized UTF-8 content before consuming a model-turn admission', () => {
    const policy = new XmtpIngressPolicy();
    const oversized = '🧠'.repeat(Math.ceil(MAX_XMTP_MESSAGE_BYTES / 4) + 1);

    expect(policy.admit('0xoversized', oversized, 1_000)).toEqual({
      accepted: false,
      reason: 'oversized',
    });
    expect(policy.retainedGlobalAdmissionCount).toBe(0);
    expect(policy.trackedSenderCount).toBe(0);
    expect(policy.admit('0xoversized', 'small follow-up', 1_001)).toEqual({
      accepted: true,
      content: 'small follow-up',
    });
  });

  it('limits sequential turns per sender and recovers after the sliding window', () => {
    const policy = new XmtpIngressPolicy();
    const start = 10_000;
    for (let index = 0; index < MAX_XMTP_TURNS_PER_SENDER; index += 1) {
      expect(policy.admit('0xsender', `turn-${index}`, start + index).accepted).toBe(true);
    }
    expect(policy.admit('0xsender', 'one too many', start + 10)).toEqual({
      accepted: false,
      reason: 'sender-rate-limit',
    });

    expect(policy.admit(
      '0xsender',
      'recovered',
      start + XMTP_INGRESS_WINDOW_MS + MAX_XMTP_TURNS_PER_SENDER,
    )).toEqual({
      accepted: true,
      content: 'recovered',
    });
  });

  it('bounds global admissions and retained sender histories under sender churn', () => {
    const policy = new XmtpIngressPolicy();
    const start = 20_000;
    let accepted = 0;
    for (let index = 0; index < MAX_XMTP_TRACKED_SENDERS * 3; index += 1) {
      const admission = policy.admit(`0xsender-${index}`, 'turn', start);
      if (admission.accepted) accepted += 1;
    }

    expect(accepted).toBe(MAX_XMTP_TURNS_GLOBAL);
    expect(policy.retainedGlobalAdmissionCount).toBeLessThanOrEqual(MAX_XMTP_TURNS_GLOBAL);
    expect(policy.trackedSenderCount).toBeLessThanOrEqual(MAX_XMTP_TRACKED_SENDERS);
    expect(policy.largestRetainedSenderHistory).toBeLessThanOrEqual(
      MAX_XMTP_TURNS_PER_SENDER,
    );
    expect(policy.admit('0xnew-sender', 'blocked globally', start + 1)).toEqual({
      accepted: false,
      reason: 'global-rate-limit',
    });

    expect(policy.admit(
      '0xnew-sender',
      'window recovered',
      start + XMTP_INGRESS_WINDOW_MS + 1,
    )).toEqual({
      accepted: true,
      content: 'window recovered',
    });
    expect(policy.retainedGlobalAdmissionCount).toBe(1);
    expect(policy.trackedSenderCount).toBe(1);
  });
});
