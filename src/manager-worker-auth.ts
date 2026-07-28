// SPDX-License-Identifier: MIT

import crypto from 'node:crypto';

export const MANAGER_SERVICE_TOKEN_ENV = 'IDACC_MANAGER_SERVICE_TOKEN';
export const MANAGER_AGENT_TOKEN_ENV = 'IDACC_MANAGER_AGENT_TOKEN';
export const MANAGER_BRAIN_SERVICE = 'brain';
export const MANAGER_TASK_RECEIPT_SERVICE = 'manager';
export const MANAGER_TASK_RECEIPT_HEADER = 'X-Id-Task-Receipt';
export const MANAGER_TASK_RECEIPT_TTL_MS = 10 * 60_000;

const AGENT_TOKEN_DOMAIN = 'idacc.manager.agent.v1';
const TASK_RECEIPT_DOMAIN = 'idacc.manager.task-receipt.v1';
const MIN_SERVICE_TOKEN_BYTES = 32;
const MAX_SERVICE_TOKEN_BYTES = 4096;
const MAX_TASK_RECEIPT_BYTES = 4096;
const TASK_RECEIPT_CLOCK_SKEW_MS = 30_000;

export interface ManagerTaskReceiptClaims {
  version: 1;
  receipt_id: string;
  team_id: string;
  owner_agent_id: string;
  task_name: string;
  task_uuid: string;
  assignment_id: string;
  issued_at: number;
  expires_at: number;
}

function bearerValue(
  authorization: string | string[] | undefined,
): string | null {
  if (
    typeof authorization !== 'string'
    || !authorization.startsWith('Bearer ')
  ) {
    return null;
  }
  const token = authorization.slice('Bearer '.length);
  return token.length > 0 ? token : null;
}

function secretMatches(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const providedDigest = crypto.createHash('sha256').update(provided, 'utf8').digest();
  return crypto.timingSafeEqual(expectedDigest, providedDigest);
}

function boundedReceiptIdentifier(
  value: unknown,
  maxLength = 240,
): string | null {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  if (value.length < 1 || value.length > maxLength) return null;
  if (!/^[a-zA-Z0-9._:#-]+$/.test(value)) return null;
  return value;
}

function canonicalTaskReceiptClaims(
  input: unknown,
): ManagerTaskReceiptClaims | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.version !== 1) return null;
  const receiptId = boundedReceiptIdentifier(value.receipt_id, 128);
  const teamId = boundedReceiptIdentifier(value.team_id);
  const ownerAgentId = boundedReceiptIdentifier(value.owner_agent_id);
  const taskName = boundedReceiptIdentifier(value.task_name);
  const taskUuid = boundedReceiptIdentifier(value.task_uuid);
  const assignmentId = boundedReceiptIdentifier(value.assignment_id);
  if (
    !receiptId
    || !teamId
    || !ownerAgentId
    || !taskName
    || !taskUuid
    || !assignmentId
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(taskName)
  ) {
    return null;
  }
  const issuedAt = value.issued_at;
  const expiresAt = value.expires_at;
  if (
    typeof issuedAt !== 'number'
    || !Number.isSafeInteger(issuedAt)
    || typeof expiresAt !== 'number'
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > MANAGER_TASK_RECEIPT_TTL_MS
  ) {
    return null;
  }
  return {
    version: 1,
    receipt_id: receiptId,
    team_id: teamId,
    owner_agent_id: ownerAgentId,
    task_name: taskName,
    task_uuid: taskUuid,
    assignment_id: assignmentId,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
}

function taskReceiptSignature(workerBearer: string, payload: string): string {
  return crypto
    .createHmac('sha256', workerBearer)
    .update(TASK_RECEIPT_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(payload, 'utf8')
    .digest('base64url');
}

/**
 * Mint a short-lived, target-bound delegation receipt. The derived worker
 * bearer is used only as an HMAC key and is never embedded in the receipt.
 */
export function issueManagerTaskReceipt(
  workerBearer: string,
  input: Omit<
    ManagerTaskReceiptClaims,
    'version' | 'receipt_id' | 'issued_at' | 'expires_at'
  >,
  now = Date.now(),
): string {
  if (!workerBearer) throw new Error('target worker bearer is required');
  const claims = canonicalTaskReceiptClaims({
    version: 1,
    receipt_id: crypto.randomBytes(18).toString('base64url'),
    ...input,
    issued_at: now,
    expires_at: now + MANAGER_TASK_RECEIPT_TTL_MS,
  });
  if (!claims) throw new Error('task receipt claims are invalid');
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${taskReceiptSignature(workerBearer, payload)}`;
}

/**
 * Verify a Manager task receipt using only the receiving worker's own derived
 * bearer. Callers never need the Manager root secret or another worker token.
 */
export function verifyManagerTaskReceipt(
  receipt: unknown,
  workerBearer: string,
  now = Date.now(),
): ManagerTaskReceiptClaims | null {
  if (
    typeof receipt !== 'string'
    || !workerBearer
    || Buffer.byteLength(receipt, 'utf8') > MAX_TASK_RECEIPT_BYTES
  ) {
    return null;
  }
  const parts = receipt.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = taskReceiptSignature(workerBearer, parts[0]);
  if (!secretMatches(expected, parts[1])) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const claims = canonicalTaskReceiptClaims(decoded);
  if (!claims) return null;
  if (
    claims.issued_at > now + TASK_RECEIPT_CLOCK_SKEW_MS
    || claims.expires_at <= now
  ) {
    return null;
  }
  return claims;
}

/**
 * Managed desktop service credentials are supervisor-generated random values.
 * Reject short, whitespace-bearing, or control-bearing values so an accidental
 * placeholder can never silently become the root of every worker credential.
 */
export function validateManagerServiceToken(token: string): string {
  const bytes = Buffer.byteLength(token, 'utf8');
  if (
    bytes < MIN_SERVICE_TOKEN_BYTES
    || bytes > MAX_SERVICE_TOKEN_BYTES
    || /[\s\u0000-\u001f\u007f]/u.test(token)
  ) {
    throw new Error(
      `${MANAGER_SERVICE_TOKEN_ENV} must be a random 32-4096 byte value without whitespace or control characters`,
    );
  }
  return token;
}

/**
 * Capture and remove the base service credential before any Manager-owned
 * child can inherit process.env. Standalone mode ignores an accidental value
 * and retains its historical HTTP behavior.
 */
export function captureManagerServiceToken(
  env: NodeJS.ProcessEnv = process.env,
  managed = Boolean(env.IDACC_ADMIN_TOKEN),
  adminToken = env.IDACC_ADMIN_TOKEN || '',
): string {
  const token = env[MANAGER_SERVICE_TOKEN_ENV] || '';
  delete env[MANAGER_SERVICE_TOKEN_ENV];
  if (!managed) return '';
  if (!token) {
    throw new Error(
      `${MANAGER_SERVICE_TOKEN_ENV} is required when IDACC_ADMIN_TOKEN enables managed mode`,
    );
  }
  validateManagerServiceToken(token);
  if (adminToken && secretMatches(adminToken, token)) {
    throw new Error(
      `${MANAGER_SERVICE_TOKEN_ENV} must be distinct from IDACC_ADMIN_TOKEN`,
    );
  }
  return token;
}

export function managerServiceBearerMatches(
  authorization: string | string[] | undefined,
  requiredToken: string,
): boolean {
  return Boolean(requiredToken) && secretMatches(requiredToken, bearerValue(authorization));
}

/**
 * Domain-separated, deterministic credential for one exact team/agent pair.
 * The base service credential never crosses the Manager/worker boundary.
 */
export function deriveManagerAgentToken(
  managerOnlyKey: string,
  teamId: string,
  agentId: string,
  processGeneration: string,
): string {
  if (!managerOnlyKey || !teamId || !agentId || !processGeneration) {
    throw new Error('manager key, team id, agent id, and process generation are required');
  }
  const hmac = crypto.createHmac('sha256', managerOnlyKey);
  for (const part of [AGENT_TOKEN_DOMAIN, teamId, agentId, processGeneration]) {
    const value = Buffer.from(part, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    hmac.update(length);
    hmac.update(value);
  }
  return hmac.digest('base64url');
}

export function managerAgentBearerMatches(
  authorization: string | string[] | undefined,
  managerOnlyKey: string,
  teamId: string,
  agentId: string,
  processGeneration: string,
): boolean {
  if (!managerOnlyKey) return false;
  return secretMatches(
    deriveManagerAgentToken(managerOnlyKey, teamId, agentId, processGeneration),
    bearerValue(authorization),
  );
}

/**
 * Validate an inbound request against this exact managed worker's
 * generation-bound bearer without exposing it to application route handlers.
 */
export function managerWorkerBearerMatches(
  authorization: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const token = env[MANAGER_AGENT_TOKEN_ENV]?.trim() || '';
  return Boolean(token) && secretMatches(token, bearerValue(authorization));
}

/**
 * Add the Manager-owned worker identity to one outbound callback. With no
 * derived token (standalone mode), return the caller's headers byte-for-byte.
 */
export function managerWorkerRequestHeaders(
  headers: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const token = env[MANAGER_AGENT_TOKEN_ENV]?.trim();
  if (!token) return { ...headers };

  const agentId = env.ID_AGENT_ID?.trim() || env.ID_DB_AGENT_ID?.trim();
  const team = env.ID_AGENT_TEAM?.trim() || env.ID_TEAM?.trim();
  if (!agentId || !team) {
    // The managed Manager will reject this request. Do not guess an identity.
    return { ...headers };
  }

  return {
    ...headers,
    'X-Id-Team': team,
    'X-Id-Agent': agentId,
    Authorization: `Bearer ${token}`,
  };
}
