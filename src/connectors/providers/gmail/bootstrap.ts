// SPDX-License-Identifier: MIT
/**
 * Registers and publishes the Gmail v1 connector against a ConnectorRegistry.
 * Pure catalog bootstrap — no connection, grant, credential, or network
 * action. Used by tests and by whatever future startup path an operator
 * approves for staging.
 */

import type { ConnectorRegistry } from '../../catalog/connector-registry.js';
import { GMAIL_CONNECTOR_ID, GMAIL_MANIFEST_VERSION, GMAIL_V1_MANIFEST } from './gmail-manifest.js';

export async function bootstrapGmailConnector(registry: ConnectorRegistry, now = Date.now()): Promise<void> {
  await registry.registerConnector({
    id: GMAIL_CONNECTOR_ID,
    displayName: 'Gmail',
    description: 'First-party Gmail OAuth/API connector. Read + draft-first at launch; send is approval-gated.',
    owner: 'idacc-connectors',
    trustTier: 'first-party',
    now,
  });
  await registry.draftVersion(GMAIL_V1_MANIFEST, 'oauth_api', now);
  await registry.publishVersion(GMAIL_CONNECTOR_ID, GMAIL_MANIFEST_VERSION, now);
}
