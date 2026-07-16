// SPDX-License-Identifier: MIT
/**
 * Structural validation for ConnectorManifest before it can be published.
 * No external schema library dependency — the manifest shape is small and
 * stable, and adding a schema-validation dependency is an operator decision
 * out of scope for this slice.
 */

import crypto from 'crypto';
import type { CapabilityManifestEntry, ConnectorManifest } from '../types.js';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const CAPABILITY_ID_RE = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;
const RISK_CLASSES = new Set(['read', 'write', 'external-write', 'destructive']);
const SIDE_EFFECTS = new Set(['none', 'draft', 'send', 'modify', 'delete']);
const APPROVAL_MODES = new Set(['auto', 'confirm', 'always', 'deny']);
const BACKEND_KINDS = new Set(['oauth_api', 'api_key', 'mcp']);

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
}

function validateCapability(cap: CapabilityManifestEntry, errors: string[]): void {
  if (!CAPABILITY_ID_RE.test(cap.id)) {
    errors.push(`capability id "${cap.id}" must be dot-namespaced lowercase (e.g. "gmail.messages.search")`);
  }
  if (!cap.operation) errors.push(`capability "${cap.id}" missing operation`);
  if (!cap.resource) errors.push(`capability "${cap.id}" missing resource`);
  if (!RISK_CLASSES.has(cap.risk)) errors.push(`capability "${cap.id}" has invalid risk "${cap.risk}"`);
  if (!SIDE_EFFECTS.has(cap.sideEffect)) {
    errors.push(`capability "${cap.id}" has invalid sideEffect "${cap.sideEffect}"`);
  }
  if (!APPROVAL_MODES.has(cap.approval)) {
    errors.push(`capability "${cap.id}" has invalid approval "${cap.approval}"`);
  }
  if (cap.hardDeny && cap.approval !== 'deny') {
    errors.push(`capability "${cap.id}" is hardDeny but approval is not "deny"`);
  }
  if ((cap.risk === 'external-write' || cap.risk === 'destructive') && cap.approval === 'auto') {
    errors.push(`capability "${cap.id}" has risk "${cap.risk}" but approval "auto" — must require confirm/always/deny`);
  }
  // Word-boundary matched so benign identifiers like "pageToken" (a Gmail
  // pagination cursor, not a credential) don't false-positive.
  const serialized = JSON.stringify(cap);
  if (/\bsecret\b|\btoken\b|\bapi[_-]?key\b|\bpassword\b/i.test(serialized)) {
    errors.push(`capability "${cap.id}" manifest text must not reference secret/token/api key/password fields`);
  }
}

/** Reject a manifest that is malformed, contains secret-shaped fields, or violates risk/approval invariants. */
export function validateConnectorManifest(manifest: ConnectorManifest): ManifestValidationResult {
  const errors: string[] = [];

  if (!manifest.connectorId || !/^[a-z0-9-]+$/.test(manifest.connectorId)) {
    errors.push(`connectorId "${manifest.connectorId}" must be a lowercase kebab-case slug`);
  }
  if (!SEMVER_RE.test(manifest.version)) {
    errors.push(`version "${manifest.version}" must be semver (x.y.z)`);
  }
  if (!manifest.backend || !BACKEND_KINDS.has(manifest.backend.kind)) {
    errors.push(`backend.kind "${manifest.backend?.kind}" must be one of ${[...BACKEND_KINDS].join(', ')}`);
  }
  if (!manifest.backend?.provider) errors.push('backend.provider is required');
  if (!manifest.backend?.binding) errors.push('backend.binding is required');

  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    errors.push('capabilities must be a non-empty array');
  } else {
    const seen = new Set<string>();
    for (const cap of manifest.capabilities) {
      if (seen.has(cap.id)) errors.push(`duplicate capability id "${cap.id}"`);
      seen.add(cap.id);
      validateCapability(cap, errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Deep-sort object keys so semantically identical manifests hash identically regardless of construction order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Stable digest used as the immutable manifest_hash for a published connector version. */
export function hashManifest(manifest: ConnectorManifest): string {
  const canonical = JSON.stringify(canonicalize(manifest));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
