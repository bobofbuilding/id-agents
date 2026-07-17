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
import { GMAIL_CAPABILITY_FLAG_GATE, GMAIL_RECIPIENT_VERIFICATION_GATE } from '../providers/gmail/gmail-manifest.js';

export interface ConnectorFeatureFlags {
  /** Master switch; when false, the router denies every invocation before any other check. */
  connectorsEnabled: boolean;
  /** Gmail OAuth/API backend (read + draft-first workflows). */
  gmailConnectorEnabled: boolean;
  /** Approval-gated gmail.drafts.send. Requires gmailConnectorEnabled. */
  gmailSendEnabled: boolean;
  /**
   * Full-body message reads (gmail.messages.get_full), split out from the
   * metadata/snippet tier of gmail.messages.get because full body content is
   * materially more sensitive. Requires gmailConnectorEnabled.
   */
  gmailFullBodyReadEnabled: boolean;
  /**
   * Send-time recipient verification for gmail.drafts.send. Requires
   * gmailSendEnabled. When true, the router binds send authorization to the
   * draft's actual recipients (resolved via an injected
   * DraftRecipientsLookup keyed on canonical connection identity — see
   * runtime/draft-recipients-lookup.ts) instead of only the caller-declared
   * `to`, and fails closed (denies) if no lookup is wired or the draft is
   * unknown. Off by default; flipping it on without a real lookup wired
   * denies every send rather than silently trusting caller-declared
   * recipients.
   */
  gmailSendRecipientVerificationEnabled: boolean;
  /** Reviewed MCP backend transport. Off until a specific server is pinned and reviewed. */
  mcpBackendEnabled: boolean;
  /**
   * Wires the additive connector registry/grants/policy/audit migrations
   * (src/connectors/catalog/migrations.ts) into the live boot chain
   * (src/db/index.ts migrateDb). Every statement is CREATE TABLE/INDEX IF
   * NOT EXISTS, so flipping this on only adds empty tables — it does not by
   * itself enable any connector, capability, or credential path. See
   * docs/connectors/gmail-first-connector-architecture.md#staged-rollout
   * stage 1.
   */
  connectorsMigrationsEnabled: boolean;
}

export const DEFAULT_CONNECTOR_FEATURE_FLAGS: ConnectorFeatureFlags = {
  connectorsEnabled: false,
  gmailConnectorEnabled: false,
  gmailSendEnabled: false,
  gmailFullBodyReadEnabled: false,
  gmailSendRecipientVerificationEnabled: false,
  mcpBackendEnabled: false,
  connectorsMigrationsEnabled: false,
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
    gmailFullBodyReadEnabled: coerceBool(
      fromFile.gmailFullBodyReadEnabled,
      DEFAULT_CONNECTOR_FEATURE_FLAGS.gmailFullBodyReadEnabled,
    ),
    gmailSendRecipientVerificationEnabled: coerceBool(
      fromFile.gmailSendRecipientVerificationEnabled,
      DEFAULT_CONNECTOR_FEATURE_FLAGS.gmailSendRecipientVerificationEnabled,
    ),
    mcpBackendEnabled: coerceBool(fromFile.mcpBackendEnabled, DEFAULT_CONNECTOR_FEATURE_FLAGS.mcpBackendEnabled),
    connectorsMigrationsEnabled: coerceBool(
      fromFile.connectorsMigrationsEnabled,
      DEFAULT_CONNECTOR_FEATURE_FLAGS.connectorsMigrationsEnabled,
    ),
  };

  return {
    connectorsEnabled: coerceBool(env.ID_CONNECTORS_ENABLED, merged.connectorsEnabled),
    gmailConnectorEnabled: coerceBool(env.ID_CONNECTORS_GMAIL_ENABLED, merged.gmailConnectorEnabled),
    gmailSendEnabled: coerceBool(env.ID_CONNECTORS_GMAIL_SEND_ENABLED, merged.gmailSendEnabled),
    gmailFullBodyReadEnabled: coerceBool(
      env.ID_CONNECTORS_GMAIL_FULL_BODY_ENABLED,
      merged.gmailFullBodyReadEnabled,
    ),
    gmailSendRecipientVerificationEnabled: coerceBool(
      env.ID_CONNECTORS_GMAIL_SEND_RECIPIENT_VERIFICATION_ENABLED,
      merged.gmailSendRecipientVerificationEnabled,
    ),
    mcpBackendEnabled: coerceBool(env.ID_CONNECTORS_MCP_ENABLED, merged.mcpBackendEnabled),
    connectorsMigrationsEnabled: coerceBool(
      env.ID_CONNECTORS_MIGRATIONS_ENABLED,
      merged.connectorsMigrationsEnabled,
    ),
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
 *
 * Provider-extensible by construction: each provider declares its own gate
 * against its own manifest (see MailProviderDefinition.flagGate /
 * buildCapabilityFlagGate in providers/mail/mail-provider-adapter.ts) and is
 * merged in here — this file never hand-transcribes a capability id string,
 * so a gate entry can't silently drift from the manifest capability it
 * describes. Gmail is the only provider registered today; adding another
 * mail provider means importing its own `*_CAPABILITY_FLAG_GATE` export and
 * spreading it into this merge, not editing capability ids by hand.
 */
export const CONNECTOR_CAPABILITY_FLAG_GATE: Record<string, keyof ConnectorFeatureFlags> = {
  ...GMAIL_CAPABILITY_FLAG_GATE,
};

/**
 * Send recipient-verification gate: capability id -> flag name that, when
 * true, turns on send-time recipient verification for that capability (see
 * ConnectorRouter step 5c, runtime/router.ts). Distinct from
 * CONNECTOR_CAPABILITY_FLAG_GATE — that gate decides whether a capability
 * can be invoked at all; this one layers an additional check onto a
 * capability that is already invocable. Provider-extensible the same way:
 * each provider declares its own gate against its own manifest (see
 * MailProviderDefinition.recipientVerificationFlag /
 * buildRecipientVerificationGate) and is merged in here.
 */
export const CONNECTOR_RECIPIENT_VERIFICATION_GATE: Record<string, keyof ConnectorFeatureFlags> = {
  ...GMAIL_RECIPIENT_VERIFICATION_GATE,
};
