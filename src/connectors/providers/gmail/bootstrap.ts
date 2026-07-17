// SPDX-License-Identifier: MIT
/**
 * Registers and publishes the Gmail v1 connector against a ConnectorRegistry.
 * Pure catalog bootstrap — no connection, grant, credential, or network
 * action. Used by tests and by whatever future startup path an operator
 * approves for staging.
 */

import type { ConnectorRegistry } from '../../catalog/connector-registry.js';
import { bootstrapMailConnector } from '../mail/mail-provider-adapter.js';
import { GMAIL_PROVIDER_DEFINITION, GMAIL_V1_MANIFEST } from './gmail-manifest.js';

export async function bootstrapGmailConnector(registry: ConnectorRegistry, now = Date.now()): Promise<void> {
  await bootstrapMailConnector(registry, GMAIL_PROVIDER_DEFINITION, GMAIL_V1_MANIFEST, now);
}
