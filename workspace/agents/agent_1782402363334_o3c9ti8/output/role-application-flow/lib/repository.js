'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { ConflictError, NotFoundError } = require('./errors');

const TERMINAL_STATUSES = new Set(['approved', 'rejected']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Server-side persistence boundary for role applications.
 *
 * The JSON file is intentionally an implementation detail. The HTTP layer
 * only depends on this interface, so it can later be replaced by SQLite or
 * Postgres without changing the submit/review contract.
 */
class JsonFileRoleApplicationRepository {
  constructor(filePath) {
    if (!filePath) {
      throw new TypeError('filePath is required');
    }

    this.filePath = path.resolve(filePath);
    this.writeQueue = Promise.resolve();
  }

  async _read() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      if (raw.trim() === '') {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.applications)) {
        throw new Error('role application store must contain an applications array');
      }
      return parsed.applications;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async _write(applications) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const serialized = `${JSON.stringify({ applications }, null, 2)}\n`;

    try {
      await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }

  async _mutate(operation) {
    const previous = this.writeQueue;
    let release;
    this.writeQueue = new Promise((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async create(input) {
    return this._mutate(async () => {
      const applications = await this._read();
      const duplicate = applications.find(
        (application) =>
          application.applicantId === input.applicantId &&
          application.roleId === input.roleId &&
          application.status !== 'rejected',
      );

      if (duplicate) {
        throw new ConflictError('An active application already exists for this applicant and role');
      }

      const now = new Date().toISOString();
      const application = {
        id: crypto.randomUUID(),
        roleId: input.roleId,
        applicantId: input.applicantId,
        applicantName: input.applicantName,
        motivation: input.motivation,
        ...(input.experience ? { experience: input.experience } : {}),
        ...(input.evidenceUrls?.length ? { evidenceUrls: [...input.evidenceUrls] } : {}),
        status: 'submitted',
        submittedAt: now,
        updatedAt: now,
        version: 1,
      };

      applications.push(application);
      await this._write(applications);
      return clone(application);
    });
  }

  async get(id) {
    const applications = await this._read();
    const application = applications.find((candidate) => candidate.id === id);
    return application ? clone(application) : null;
  }

  async list(filter = {}) {
    const applications = await this._read();
    return applications
      .filter((application) => !filter.status || application.status === filter.status)
      .filter((application) => !filter.roleId || application.roleId === filter.roleId)
      .filter((application) => !filter.applicantId || application.applicantId === filter.applicantId)
      .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))
      .map(clone);
  }

  async review(id, input) {
    return this._mutate(async () => {
      const applications = await this._read();
      const index = applications.findIndex((application) => application.id === id);

      if (index === -1) {
        throw new NotFoundError();
      }

      const current = applications[index];
      if (current.version !== input.expectedVersion) {
        throw new ConflictError('The application changed; refresh it before reviewing');
      }
      if (TERMINAL_STATUSES.has(current.status)) {
        throw new ConflictError('A terminal review decision cannot be changed');
      }

      const now = new Date().toISOString();
      const updated = {
        ...current,
        status: input.decision,
        updatedAt: now,
        reviewedAt: now,
        reviewedBy: input.reviewedBy,
        ...(input.reviewNote ? { reviewNote: input.reviewNote } : {}),
        version: current.version + 1,
      };

      applications[index] = updated;
      await this._write(applications);
      return clone(updated);
    });
  }
}

module.exports = {
  JsonFileRoleApplicationRepository,
  TERMINAL_STATUSES,
};
