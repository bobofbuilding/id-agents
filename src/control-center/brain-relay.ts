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
const MAX_TIMELINE_PATH_BYTES = 2 * 1024;
const MAX_TIMELINE_LIMIT = 100;
const MAX_TIMELINE_FILTER_CHARS = 160;
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9:._-]{8,160}$/;
const SECRET_KEY = /^(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|authorization|auth|bearer|private[-_]?key)$/i;

const GET_PATHS = [
  /^\/health$/,
  /^\/fleet-report$/,
  /^\/controllers(?:\?.*)?$/,
  /^\/graph\/app\/data(?:\?.*)?$/,
  /^\/skills\/index(?:\?.*)?$/,
  /^\/memory\/tiers(?:\?.*)?$/,
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
  /^\/learning-tasks$/,
  /^\/approvals\/[^/?#]+\/resolve$/,
];

function boundedTimelineReadPath(path: string): string | null {
  if (path !== '/timeline' && !path.startsWith('/timeline?')) return null;
  if (Buffer.byteLength(path, 'utf8') > MAX_TIMELINE_PATH_BYTES) {
    throw new Error('invalid_brain_timeline_query');
  }

  let parsed: URL;
  try {
    parsed = new URL(path, 'http://brain.invalid');
  } catch {
    throw new Error('invalid_brain_timeline_query');
  }
  if (parsed.pathname !== '/timeline' || parsed.hash) throw new Error('invalid_brain_timeline_query');

  const allowedKeys = new Set(['source', 'type', 'since', 'limit']);
  for (const key of parsed.searchParams.keys()) {
    if (!allowedKeys.has(key) || parsed.searchParams.getAll(key).length !== 1) {
      throw new Error('invalid_brain_timeline_query');
    }
  }

  const limitText = parsed.searchParams.get('limit');
  if (!limitText || !/^\d+$/.test(limitText)) throw new Error('invalid_brain_timeline_query');
  const limit = Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TIMELINE_LIMIT) {
    throw new Error('invalid_brain_timeline_query');
  }

  const sinceText = parsed.searchParams.get('since');
  if (sinceText !== null && (!/^\d+$/.test(sinceText) || !Number.isSafeInteger(Number(sinceText)))) {
    throw new Error('invalid_brain_timeline_query');
  }
  for (const key of ['source', 'type']) {
    const value = parsed.searchParams.get(key);
    if (value !== null && (!value || value.length > MAX_TIMELINE_FILTER_CHARS || /[\u0000-\u001f\u007f]/.test(value))) {
      throw new Error('invalid_brain_timeline_query');
    }
  }

  // Canonicalize the numeric controls while retaining the caller's bounded
  // source/type filters. Brain sees the same route family, never an arbitrary URL.
  parsed.searchParams.set('limit', String(limit));
  if (sinceText !== null) parsed.searchParams.set('since', String(Number(sinceText)));
  return `${parsed.pathname}?${parsed.searchParams.toString()}`;
}

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
  if (!path.startsWith('/') || path.includes('://') || path.includes('\\') || path.includes('#') || /[\r\n]/.test(path)) {
    throw new Error('invalid_brain_path');
  }
  const timelinePath = method === 'GET' ? boundedTimelineReadPath(path) : null;
  const normalizedPath = timelinePath ?? path;
  const allowed = timelinePath !== null
    || (method === 'GET' ? GET_PATHS : POST_PATHS).some((pattern) => pattern.test(normalizedPath));
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
    path: normalizedPath,
    ...(body !== undefined ? { body: body as Record<string, unknown> } : {}),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  };
}
