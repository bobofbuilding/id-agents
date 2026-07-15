// SPDX-License-Identifier: MIT
/**
 * Transport / boundary error taxonomy shared by the client and the validation
 * layer. Kept in its own module so `validation.ts` can throw `ManagerError`
 * without importing `client.ts` (which imports `validation.ts`).
 *
 *   - NetworkError — couldn't reach the manager, or the manager returned 5xx.
 *   - ManagerError — the manager understood and rejected (4xx, an
 *     `{ ok:false, error }` envelope, OR a structurally malformed response that
 *     fails boundary validation).
 */

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class ManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagerError';
  }
}
