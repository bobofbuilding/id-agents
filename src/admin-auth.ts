// SPDX-License-Identifier: MIT

import crypto from 'node:crypto';

/**
 * Validate the optional IDACC admin bearer without comparing secret strings
 * directly. Hashing both values produces fixed-length buffers for the
 * constant-time comparison and avoids leaking a prefix or mismatch position.
 */
export function adminBearerMatches(
  authorization: string | string[] | undefined,
  requiredToken = process.env.IDACC_ADMIN_TOKEN,
): boolean {
  if (!requiredToken) return true;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const provided = authorization.slice('Bearer '.length);
  const expectedDigest = crypto.createHash('sha256').update(requiredToken, 'utf8').digest();
  const providedDigest = crypto.createHash('sha256').update(provided, 'utf8').digest();
  return crypto.timingSafeEqual(expectedDigest, providedDigest);
}

/** Add the optional IDACC admin bearer to trusted internal/CLI admin calls. */
export function adminAuthorizationHeaders(
  token = process.env.IDACC_ADMIN_TOKEN,
): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Move the supervisor-only credential out of process.env before the Manager
 * can spawn agents. The returned value stays in the Manager instance only.
 */
export function captureAdminToken(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const token = env.IDACC_ADMIN_TOKEN || '';
  delete env.IDACC_ADMIN_TOKEN;
  return token;
}
