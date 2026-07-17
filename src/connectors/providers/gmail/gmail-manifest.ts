// SPDX-License-Identifier: MIT
/**
 * Gmail v1 connector manifest. Data only — no network code, no credentials.
 * Mirrors the capability set frozen in
 * docs/connectors/gmail-first-connector-architecture.md#gmail-first-capability-set.
 *
 * Keep this list intentionally small at launch: read + draft-first, with
 * send behind mandatory approval and destructive/account-control operations
 * hard-denied. Expanding it is a manifest version bump, not an edit.
 */

import type { ConnectorManifest } from '../../types.js';
import { buildMailManifest, grantableCapabilityIds, type MailProviderDefinition } from '../mail/mail-provider-adapter.js';

export const GMAIL_CONNECTOR_ID = 'gmail';
export const GMAIL_MANIFEST_VERSION = '1.0.0';

export const GMAIL_PROVIDER_DEFINITION: MailProviderDefinition = {
  connectorId: GMAIL_CONNECTOR_ID,
  version: GMAIL_MANIFEST_VERSION,
  displayName: 'Gmail',
  description: 'First-party Gmail OAuth/API connector. Read + draft-first at launch; send is approval-gated.',
  owner: 'idacc-connectors',
  trustTier: 'first-party',
  backend: { kind: 'oauth_api', provider: 'google', binding: 'google-gmail-v1' },
  // Gmail calls the canonical "folders" resource "labels", and its
  // account-control settings surface is specifically mail forwarding rules.
  resourceAliases: { 'folders.list': 'labels' },
  idSuffixAliases: { 'settings.accountControl': 'forwarding' },
};

export const GMAIL_V1_MANIFEST: ConnectorManifest = buildMailManifest(GMAIL_PROVIDER_DEFINITION);

/** Capability ids that a grant may reference at launch (excludes hard-denied entries). */
export const GMAIL_GRANTABLE_CAPABILITY_IDS = grantableCapabilityIds(GMAIL_V1_MANIFEST);
