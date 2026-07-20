// SPDX-License-Identifier: MIT

export const CONTROL_BRAIN_REQUESTED = 'control:brain-write:requested';
export const CONTROL_BRAIN_DELIVERED = 'control:brain-write:delivered';

export type ControlBrainMethod = 'GET' | 'POST';

export interface ControlBrainRequest {
  method: ControlBrainMethod;
  path: string;
  body?: Record<string, unknown>;
  idempotency_key?: string;
}

const MAX_BODY_BYTES = 128 * 1024;
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9:._-]{8,160}$/;
const SECRET_KEY = /^(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|authorization|auth|bearer|private[-_]?key)$/i;

const GET_PATHS = [
  /^\/health$/,
  /^\/fleet-report$/,
  /^\/controllers(?:\?.*)?$/,
  /^\/graph\/app\/data(?:\?.*)?$/,
  /^\/skills\/index(?:\?.*)?$/,
  /^\/memory\/shared(?:\?.*)?$/,
  /^\/memory\/[^/?#]+\/[^/?#]+$/,
  /^\/approvals(?:\?.*)?$/,
];

const POST_PATHS = [
  /^\/timeline$/,
  /^\/entities$/,
  /^\/facts\/bulk$/,
  /^\/entity-edges\/bulk$/,
  /^\/text-units\/ingest$/,
  /^\/graph\/nodes\/bulk$/,
  /^\/memory\/[^/?#]+$/,
  /^\/approvals\/[^/?#]+\/resolve$/,
];

export function redactControlBrainValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactControlBrainValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? (item ? '[redacted]' : item) : redactControlBrainValue(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(/\b(?:sk|pk|ak|rk)-[A-Za-z0-9_-]{16,}\b/g, '[redacted-key]')
      .replace(/\b0x[a-fA-F0-9]{64}\b/g, '[redacted-hex-secret]')
      .slice(0, 32_000);
  }
  return value;
}

export function parseControlBrainRequest(value: unknown): ControlBrainRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request_body_required');
  const input = value as Record<string, unknown>;
  const method = String(input.method || '').toUpperCase();
  const path = String(input.path || '').trim();
  if (method !== 'GET' && method !== 'POST') throw new Error('invalid_brain_method');
  if (!path.startsWith('/') || path.includes('://') || path.includes('\\') || /[\r\n]/.test(path)) {
    throw new Error('invalid_brain_path');
  }
  const allowed = (method === 'GET' ? GET_PATHS : POST_PATHS).some((pattern) => pattern.test(path));
  if (!allowed) throw new Error('brain_path_not_allowed');

  const body = input.body === undefined ? undefined : redactControlBrainValue(input.body);
  if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body))) {
    throw new Error('invalid_brain_body');
  }
  if (body !== undefined && Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
    throw new Error('brain_body_too_large');
  }

  const idempotencyKey = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : '';
  if (method === 'POST' && !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new Error('invalid_idempotency_key');
  return {
    method,
    path,
    ...(body !== undefined ? { body: body as Record<string, unknown> } : {}),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  };
}
