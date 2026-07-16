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

export const GMAIL_CONNECTOR_ID = 'gmail';
export const GMAIL_MANIFEST_VERSION = '1.0.0';

export const GMAIL_V1_MANIFEST: ConnectorManifest = {
  connectorId: GMAIL_CONNECTOR_ID,
  version: GMAIL_MANIFEST_VERSION,
  backend: { kind: 'oauth_api', provider: 'google', binding: 'google-gmail-v1' },
  capabilities: [
    {
      id: 'gmail.messages.search',
      operation: 'search',
      resource: 'messages',
      risk: 'read',
      sideEffect: 'none',
      approval: 'auto',
      inputSchema: { query: 'string', pageToken: 'string?', maxResults: 'number?' },
    },
    {
      id: 'gmail.messages.get',
      operation: 'get',
      resource: 'messages',
      risk: 'read',
      sideEffect: 'none',
      approval: 'auto',
      inputSchema: { messageId: 'string', format: 'metadata|snippet|full' },
    },
    {
      id: 'gmail.threads.get',
      operation: 'get',
      resource: 'threads',
      risk: 'read',
      sideEffect: 'none',
      approval: 'auto',
      inputSchema: { threadId: 'string', maxMessages: 'number?' },
    },
    {
      id: 'gmail.labels.list',
      operation: 'list',
      resource: 'labels',
      risk: 'read',
      sideEffect: 'none',
      approval: 'auto',
      inputSchema: {},
    },
    {
      id: 'gmail.attachments.metadata',
      operation: 'metadata',
      resource: 'attachments',
      risk: 'read',
      sideEffect: 'none',
      approval: 'auto',
      inputSchema: { messageId: 'string', attachmentId: 'string' },
    },
    {
      id: 'gmail.drafts.create',
      operation: 'create',
      resource: 'drafts',
      risk: 'write',
      sideEffect: 'draft',
      approval: 'auto',
      inputSchema: { to: 'string[]', subject: 'string', body: 'string' },
    },
    {
      id: 'gmail.drafts.update',
      operation: 'update',
      resource: 'drafts',
      risk: 'write',
      sideEffect: 'draft',
      approval: 'auto',
      inputSchema: { draftId: 'string', to: 'string[]?', subject: 'string?', body: 'string?' },
    },
    {
      id: 'gmail.drafts.send',
      operation: 'send',
      resource: 'drafts',
      risk: 'external-write',
      sideEffect: 'send',
      approval: 'always',
      inputSchema: { draftId: 'string' },
      notes: 'Draft-first send. Approval must bind the exact recipient/body/attachment hash and an idempotency key.',
    },
    {
      id: 'gmail.messages.send',
      operation: 'send',
      resource: 'messages',
      risk: 'external-write',
      sideEffect: 'send',
      approval: 'deny',
      hardDeny: true,
      inputSchema: {},
      notes: 'No direct send bypassing draft/approval. Revisit only after pilot evidence.',
    },
    {
      id: 'gmail.messages.trash',
      operation: 'trash',
      resource: 'messages',
      risk: 'destructive',
      sideEffect: 'delete',
      approval: 'deny',
      hardDeny: true,
      inputSchema: {},
    },
    {
      id: 'gmail.messages.delete',
      operation: 'delete',
      resource: 'messages',
      risk: 'destructive',
      sideEffect: 'delete',
      approval: 'deny',
      hardDeny: true,
      inputSchema: {},
    },
    {
      id: 'gmail.settings.forwarding',
      operation: 'update',
      resource: 'settings',
      risk: 'destructive',
      sideEffect: 'modify',
      approval: 'deny',
      hardDeny: true,
      inputSchema: {},
      notes: 'Account-control and data-exfiltration surface. Hard-denied at launch.',
    },
  ],
};

/** Capability ids that a grant may reference at launch (excludes hard-denied entries). */
export const GMAIL_GRANTABLE_CAPABILITY_IDS = GMAIL_V1_MANIFEST.capabilities
  .filter((c) => !c.hardDeny)
  .map((c) => c.id);
