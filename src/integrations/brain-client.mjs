// SPDX-License-Identifier: MIT

/**
 * Bounded Brain client for publishing one terminal contribution summary.
 * Only citation aliases and status fields are ever written to shared memory;
 * review reasoning, artifact filenames, and raw `memory:<id>` source ids are
 * never forwarded, since they may carry private reviewer evidence.
 */
export class BrainClientError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'BrainClientError';
    this.retryable = retryable;
  }
}

export function sanitizeBrainTerminalSummary(input) {
  if (!input || typeof input.submissionId !== 'string' || input.submissionId.length === 0) {
    throw new Error('submission id is required');
  }
  const citationAliases = Array.isArray(input.citationAliases)
    ? input.citationAliases.filter((alias) => typeof alias === 'string' && !/^memory:/.test(alias))
    : [];
  return {
    submissionId: input.submissionId,
    reviewOutcome: input.reviewOutcome ?? null,
    managerStatus: input.managerStatus ?? null,
    title: typeof input.title === 'string' ? input.title : null,
    citationAliases,
  };
}

function buildContent(safe) {
  const lines = [
    `submission: ${safe.submissionId}`,
    `review_outcome: ${safe.reviewOutcome}`,
    `manager_status: ${safe.managerStatus}`,
  ];
  if (safe.title) lines.push(`title: ${safe.title}`);
  for (const alias of safe.citationAliases) lines.push(`citation: ${alias}`);
  return lines.join('\n');
}

export class BrainClient {
  constructor({ baseUrl, agentId, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.agentId = agentId;
    this.fetchImpl = fetchImpl;
  }

  async publishTerminalSummary(input) {
    const safe = sanitizeBrainTerminalSummary(input);
    const body = {
      key: `bittrees:submission:${safe.submissionId}:terminal:v1`,
      content: buildContent(safe),
      tags: ['bittrees', 'contribution', 'terminal'],
      shared: true,
    };
    const res = await this.fetchImpl(`${this.baseUrl}/memory/${this.agentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new BrainClientError(`Brain request failed with status ${res.status}`, {
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    const json = await res.json();
    if (!json.ok) {
      throw new BrainClientError('Brain rejected memory publish', { retryable: false });
    }
    return { ok: true };
  }
}
