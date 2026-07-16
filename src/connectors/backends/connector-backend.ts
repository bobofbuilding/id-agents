// SPDX-License-Identifier: MIT
/**
 * Backend adapter port. OAuth/API/MCP is a transport choice, not a
 * capability grant — the router evaluates policy identically regardless of
 * which ConnectorBackend implementation ultimately serves a capability, and
 * only calls invoke() after grant + approval checks have already passed.
 */

import type { BackendKind, CapabilityManifestEntry, ConnectionRecord } from '../types.js';

export interface BackendInvocation {
  capability: CapabilityManifestEntry;
  connection: ConnectionRecord;
  args: unknown;
  requestId: string;
}

export interface BackendResult {
  ok: boolean;
  /** Normalized, redacted-per-manifest provider result. Absent when ok is false. */
  data?: unknown;
  /** Set when ok is false; distinguishes retryable transport errors from provider-side errors. */
  errorKind?: 'retryable' | 'provider' | 'not_connected';
  errorMessage?: string;
}

export interface HealthResult {
  healthy: boolean;
  detail?: string;
}

export interface BackendBinding {
  name: string;
  kind: BackendKind;
  /** Reviewed/allowlisted origin or MCP server identity this binding is pinned to. */
  allowlistedOrigin: string;
}

export interface ConnectorBackend {
  readonly kind: BackendKind;
  validateBinding(binding: BackendBinding): Promise<void>;
  health(binding: BackendBinding): Promise<HealthResult>;
  invoke(ctx: BackendInvocation): Promise<BackendResult>;
  revoke?(connection: ConnectionRecord): Promise<void>;
}
