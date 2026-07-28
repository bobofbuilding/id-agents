// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';

/** Maximum UTF-8 payload accepted before any prompt or model turn is built. */
export const MAX_XMTP_MESSAGE_BYTES = 24 * 1024;
/** Sliding-window duration used for sequential-turn admission control. */
export const XMTP_INGRESS_WINDOW_MS = 60_000;
/** Per cryptographic sender turn budget within one sliding window. */
export const MAX_XMTP_TURNS_PER_SENDER = 4;
/** Aggregate turn budget for one agent within one sliding window. */
export const MAX_XMTP_TURNS_GLOBAL = 16;
/** Hard memory bound for retained sender histories. */
export const MAX_XMTP_TRACKED_SENDERS = 256;
const MAX_XMTP_SENDER_BYTES = 512;

export type XmtpIngressRejection =
  | 'invalid-sender'
  | 'oversized'
  | 'sender-rate-limit'
  | 'global-rate-limit';

export type XmtpIngressAdmission =
  | { accepted: true; content: string }
  | { accepted: false; reason: XmtpIngressRejection };

/**
 * Bounded in-memory sliding-window guard. Rate limits use local receipt time,
 * never the sender-provided message timestamp.
 */
export class XmtpIngressPolicy {
  private globalAdmissions: number[] = [];
  private senderAdmissions = new Map<string, number[]>();

  admit(senderAddress: unknown, content: unknown, now = Date.now()): XmtpIngressAdmission {
    const sender = typeof senderAddress === 'string' ? senderAddress.trim().toLowerCase() : '';
    if (
      !sender
      || Buffer.byteLength(sender, 'utf8') > MAX_XMTP_SENDER_BYTES
      || !Number.isFinite(now)
    ) {
      return { accepted: false, reason: 'invalid-sender' };
    }

    const message = typeof content === 'string' ? content : '';
    if (Buffer.byteLength(message, 'utf8') > MAX_XMTP_MESSAGE_BYTES) {
      return { accepted: false, reason: 'oversized' };
    }

    this.prune(now);
    const senderKey = createHash('sha256').update(sender, 'utf8').digest('hex');
    const priorSenderAdmissions = this.senderAdmissions.get(senderKey) ?? [];
    if (priorSenderAdmissions.length >= MAX_XMTP_TURNS_PER_SENDER) {
      return { accepted: false, reason: 'sender-rate-limit' };
    }
    if (this.globalAdmissions.length >= MAX_XMTP_TURNS_GLOBAL) {
      return { accepted: false, reason: 'global-rate-limit' };
    }

    const nextSenderAdmissions = [...priorSenderAdmissions, now];
    // Map insertion order is used as bounded least-recently-admitted order.
    this.senderAdmissions.delete(senderKey);
    while (
      !this.senderAdmissions.has(senderKey)
      && this.senderAdmissions.size >= MAX_XMTP_TRACKED_SENDERS
    ) {
      const oldest = this.senderAdmissions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.senderAdmissions.delete(oldest);
    }
    this.senderAdmissions.set(senderKey, nextSenderAdmissions);
    this.globalAdmissions.push(now);
    return { accepted: true, content: message };
  }

  get trackedSenderCount(): number {
    return this.senderAdmissions.size;
  }

  get retainedGlobalAdmissionCount(): number {
    return this.globalAdmissions.length;
  }

  get largestRetainedSenderHistory(): number {
    let largest = 0;
    for (const timestamps of this.senderAdmissions.values()) {
      largest = Math.max(largest, timestamps.length);
    }
    return largest;
  }

  private prune(now: number): void {
    const cutoff = now - XMTP_INGRESS_WINDOW_MS;
    this.globalAdmissions = this.globalAdmissions.filter((timestamp) => timestamp > cutoff);
    for (const [sender, timestamps] of this.senderAdmissions) {
      const retained = timestamps.filter((timestamp) => timestamp > cutoff);
      if (retained.length === 0) {
        this.senderAdmissions.delete(sender);
      } else {
        this.senderAdmissions.set(sender, retained);
      }
    }
  }
}
