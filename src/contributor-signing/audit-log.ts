// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { AuditEnvelope, ContributorDecisionRecord, DecisionAuditLog } from './types.js';

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function envelopeHash(
  sequence: number,
  recordedAt: string,
  previousHash: string | null,
  record: ContributorDecisionRecord,
): string {
  return digest(JSON.stringify({ sequence, recorded_at: recordedAt, previous_hash: previousHash, record }));
}

export class InMemoryAppendOnlyDecisionAuditLog implements DecisionAuditLog {
  private readonly log: AuditEnvelope[] = [];

  append(record: ContributorDecisionRecord): AuditEnvelope {
    const sequence = this.log.length + 1;
    const previousHash = this.log.at(-1)?.entry_hash || null;
    const recordedAt = new Date().toISOString();
    const envelope: AuditEnvelope = Object.freeze({
      sequence,
      recorded_at: recordedAt,
      previous_hash: previousHash,
      entry_hash: envelopeHash(sequence, recordedAt, previousHash, record),
      record: Object.freeze({ ...record }),
    });
    this.log.push(envelope);
    return envelope;
  }

  entries(): readonly AuditEnvelope[] {
    return this.log.map(entry => ({ ...entry, record: { ...entry.record } }));
  }
}

/** JSONL writer with no update/delete API. Each entry is hash-linked to the previous one. */
export class JsonlAppendOnlyDecisionAuditLog implements DecisionAuditLog {
  private sequence = 0;
  private previousHash: string | null = null;

  constructor(private readonly filePath: string) {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    let expectedPrevious: string | null = null;
    for (const [index, line] of lines.entries()) {
      const envelope = JSON.parse(line) as AuditEnvelope;
      const expectedHash = envelopeHash(envelope.sequence, envelope.recorded_at, envelope.previous_hash, envelope.record);
      if (envelope.sequence !== index + 1 || envelope.previous_hash !== expectedPrevious || envelope.entry_hash !== expectedHash) {
        throw new Error(`Decision audit log integrity failure at sequence ${index + 1}`);
      }
      expectedPrevious = envelope.entry_hash;
    }
    this.sequence = lines.length;
    this.previousHash = expectedPrevious;
  }

  append(record: ContributorDecisionRecord): AuditEnvelope {
    const sequence = this.sequence + 1;
    const recordedAt = new Date().toISOString();
    const envelope: AuditEnvelope = {
      sequence,
      recorded_at: recordedAt,
      previous_hash: this.previousHash,
      entry_hash: envelopeHash(sequence, recordedAt, this.previousHash, record),
      record: { ...record },
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
    this.sequence = sequence;
    this.previousHash = envelope.entry_hash;
    return Object.freeze({ ...envelope, record: Object.freeze({ ...record }) });
  }
}
