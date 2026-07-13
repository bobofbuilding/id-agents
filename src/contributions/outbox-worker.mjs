// SPDX-License-Identifier: MIT

import { IdaccManagerError } from '../integrations/idacc-manager-client.mjs';
import { BrainClientError } from '../integrations/brain-client.mjs';

/** Stable, submission-derived task name so retries never create a duplicate. */
export function deterministicTaskName(submissionId) {
  return `bittrees-submission-${submissionId}`;
}

export class InMemoryIntegrationOutboxStore {
  constructor() {
    this._rows = [];
    this._seq = 0;
  }

  enqueue(type, payload, meta = {}) {
    this._seq += 1;
    const row = {
      id: meta.id ?? `row-${this._seq}`,
      type,
      payload,
      status: 'pending',
      attempts: 0,
      availableAt: meta.availableAt ?? 0,
      lastError: null,
    };
    this._rows.push(row);
    return row;
  }

  due(now) {
    return this._rows.filter((row) => (row.status === 'pending' || row.status === 'retry') && row.availableAt <= now);
  }

  rows() {
    return this._rows;
  }
}

function isRetryable(err) {
  if (err instanceof IdaccManagerError) return !!err.retryable;
  if (err instanceof BrainClientError) return !!err.retryable;
  return false;
}

export class ContributionOutboxWorker {
  constructor({ store, managerClient, brainClient, clock = Date.now, maxAttempts = 5, jitterMs = 250 }) {
    this.store = store;
    this.managerClient = managerClient;
    this.brainClient = brainClient;
    this.clock = clock;
    this.maxAttempts = maxAttempts;
    this.jitterMs = jitterMs;
  }

  _backoff(attempts) {
    const base = 500 * 2 ** Math.max(0, attempts - 1);
    const jitter = this.jitterMs ? Math.floor(Math.random() * this.jitterMs) : 0;
    return base + jitter;
  }

  async _processIdaccCreate(row) {
    const name = deterministicTaskName(row.payload.submissionId);
    try {
      const created = await this.managerClient.createBoundedTask({ name, title: row.payload.title });
      return { name, status: `idacc_${created.status}` };
    } catch (err) {
      // An ambiguous (retryable) failure may mean the task was already
      // created; reconcile with a GET before ever issuing a second POST so
      // a timeout never produces a duplicate task.
      if (err instanceof IdaccManagerError && err.retryable) {
        const existing = await this.managerClient.getTask(name);
        if (existing) {
          return { name, status: `idacc_${existing.status}` };
        }
      }
      throw err;
    }
  }

  async _processBrainSummary(row) {
    return this.brainClient.publishTerminalSummary(row.payload);
  }

  async _processRow(row) {
    if (row.type === 'idacc_task_create') return this._processIdaccCreate(row);
    if (row.type === 'brain_terminal_summary') return this._processBrainSummary(row);
    throw new Error(`unknown outbox event type: ${row.type}`);
  }

  async processOnce() {
    const now = this.clock();
    const due = this.store.due(now);
    const results = [];
    let sent = 0;
    let retried = 0;
    let failed = 0;

    for (const row of due) {
      try {
        const result = await this._processRow(row);
        row.status = 'sent';
        row.lastError = null;
        sent += 1;
        results.push({ id: row.id, result });
      } catch (err) {
        row.attempts += 1;
        row.lastError = err.message;
        if (isRetryable(err) && row.attempts < this.maxAttempts) {
          row.status = 'retry';
          row.availableAt = now + this._backoff(row.attempts);
          retried += 1;
        } else {
          row.status = 'failed';
          failed += 1;
        }
        results.push({ id: row.id, error: err.message });
      }
    }

    return { sent, retried, failed, results };
  }
}
