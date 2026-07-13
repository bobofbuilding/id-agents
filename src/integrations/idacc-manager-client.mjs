// SPDX-License-Identifier: MIT

/**
 * Bounded client for the IDACC manager task API. Only exposes the two calls
 * the contribution outbox needs (create/get); it never forwards free-text
 * review fields, and it never touches claim/done/assign/capability/wallet or
 * registry routes, so a submission bridge cannot escalate beyond filing a
 * tracked task.
 */
export class IdaccManagerError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'IdaccManagerError';
    this.retryable = retryable;
  }
}

function mapTask(task) {
  if (!task) return null;
  return {
    name: task.name,
    uuid: task.uuid,
    status: task.status,
    updatedAt: task.updated_at ?? null,
  };
}

export class IdaccManagerClient {
  constructor({ baseUrl, team = 'engineering-team', fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.team = team;
    this.fetchImpl = fetchImpl;
  }

  async createBoundedTask({ name, title }) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new IdaccManagerError('task name is required', { retryable: false });
    }
    const res = await this.fetchImpl(`${this.baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': this.team },
      body: JSON.stringify({ title, name, from: 'portal-submission-bridge' }),
    });
    if (!res.ok) {
      throw new IdaccManagerError(`manager create failed with status ${res.status}`, {
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    const json = await res.json();
    return mapTask(json.task);
  }

  async getTask(name) {
    const res = await this.fetchImpl(`${this.baseUrl}/tasks/${encodeURIComponent(name)}`, {
      method: 'GET',
      headers: { 'X-Id-Team': this.team },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new IdaccManagerError(`manager get failed with status ${res.status}`, {
        retryable: res.status >= 500,
      });
    }
    const json = await res.json();
    return mapTask(json.task);
  }
}
