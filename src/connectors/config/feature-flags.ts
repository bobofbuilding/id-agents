// SPDX-License-Identifier: MIT
/**
 * Connector feature flags. Every connector capability is denied unless its
 * flag is explicitly true. Defaults ship OFF; see
 * config/feature-flags/connectors.json and
 * docs/connectors/gmail-first-connector-architecture.md#staged-rollout for
 * the rollout sequence.
 */

import fs from 'fs';
import path from 'path';

export interface ConnectorFeatureFlags {
  /** Master switch; when false, the router denies every invocation before any other check. */
  connectorsEnabled: boolean;
  /** Gmail OAuth/API backend (read + draft-first workflows). */
  gmailConnectorEnabled: boolean;
  /** Approval-gated gmail.drafts.send. Requires gmailConnectorEnabled. */
  gmailSendEnabled: boolean;
  /** Reviewed MCP backend transport. Off until a specific server is pinned and reviewed. */
  mcpBackendEnabled: boolean;
}

export const DEFAULT_CONNECTOR_FEATURE_FLAGS: ConnectorFeatureFlags = {
  connectorsEnabled: false,
  gmailConnectorEnabled: false,
  gmailSendEnabled: false,
  mcpBackendEnabled: false,
};

const CONFIG_RELATIVE_PATH = path.join('config', 'feature-flags', 'connectors.json');

function coerceBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return fallback;
}

/**
 * Load flags from config/feature-flags/connectors.json (repo-root relative),
 * then apply ID_CONNECTORS_* env overrides on top. Malformed or missing file
 * falls back to all-OFF defaults rather than throwing, so a bad deploy can
 * only fail closed.
 */
export function loadConnectorFeatureFlags(
  repoRoot: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ConnectorFeatureFlags {
  let fromFile: Partial<ConnectorFeatureFlags> = {};
  try {
    const raw = fs.readFileSync(path.join(repoRoot, CONFIG_RELATIVE_PATH), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') fromFile = parsed as Partial<ConnectorFeatureFlags>;
  } catch {
    // Missing/malformed file → all-OFF defaults.
  }

  const merged: ConnectorFeatureFlags = {
    connectorsEnabled: coerceBool(fromFile.connectorsEnabled, DEFAULT_CONNECTOR_FEATURE_FLAGS.connectorsEnabled),
    gmailConnectorEnabled: coerceBool(
      fromFile.gmailConnectorEnabled,
      DEFAULT_CONNECTOR_FEATURE_FLAGS.gmailConnectorEnabled,
    ),
    gmailSendEnabled: coerceBool(fromFile.gmailSendEnabled, DEFAULT_CONNECTOR_FEATURE_FLAGS.gmailSendEnabled),
    mcpBackendEnabled: coerceBool(fromFile.mcpBackendEnabled, DEFAULT_CONNECTOR_FEATURE_FLAGS.mcpBackendEnabled),
  };

  return {
    connectorsEnabled: coerceBool(env.ID_CONNECTORS_ENABLED, merged.connectorsEnabled),
    gmailConnectorEnabled: coerceBool(env.ID_CONNECTORS_GMAIL_ENABLED, merged.gmailConnectorEnabled),
    gmailSendEnabled: coerceBool(env.ID_CONNECTORS_GMAIL_SEND_ENABLED, merged.gmailSendEnabled),
    mcpBackendEnabled: coerceBool(env.ID_CONNECTORS_MCP_ENABLED, merged.mcpBackendEnabled),
  };
}

/**
 * Capability-specific flag gate: beyond the per-connector flag, some
 * individual capabilities require their own additional flag before the
 * router will consider them. Keyed by capability id (not connector id) so a
 * single connector can stage send-class operations behind a narrower flag
 * than its read/draft capabilities. See ConnectorRouter step 3b
 * (runtime/router.ts) for where this is enforced, and
 * docs/connectors/gmail-first-connector-architecture.md#staged-rollout
 * stage 4 for the rollout sequencing this exists to support.
 */
export const CONNECTOR_CAPABILITY_FLAG_GATE: Record<string, keyof ConnectorFeatureFlags> = {
  'gmail.drafts.send': 'gmailSendEnabled',
};
