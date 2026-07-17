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

/**
 * Absolute per-invocation ceiling for gmail.attachments.download, enforced by
 * the router (RouterDeps step 5b) regardless of any grant. A grant's
 * `resourceScope.maxAttachmentBytes` may narrow this further but can never
 * widen past it. Conservative pilot default — well under Gmail's ~35MB
 * attachment API ceiling — pending operator sign-off on a larger value once
 * real download traffic is observed (see Open decisions in
 * docs/connectors/gmail-first-connector-architecture.md).
 */
export const GMAIL_ATTACHMENT_DOWNLOAD_HARD_CAP_BYTES = 10_000_000;

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
      inputSchema: { messageId: 'string', format: 'metadata|snippet' },
      notes: 'Metadata/snippet only. Full body is a separate, stricter capability — see gmail.messages.get_full.',
    },
    {
      id: 'gmail.messages.get_full',
      operation: 'get_full',
      resource: 'messages',
      risk: 'read',
      sideEffect: 'none',
      approval: 'confirm',
      inputSchema: { messageId: 'string' },
      notes:
        'Full message body content. Split out of gmail.messages.get and gated behind its own feature flag ' +
        '(gmailFullBodyReadEnabled, off by default) plus per-invocation confirmation — full body is materially ' +
        'more sensitive than metadata/snippet reads.',
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
      id: 'gmail.attachments.download',
      operation: 'download',
      resource: 'attachments',
      risk: 'read',
      sideEffect: 'none',
      approval: 'auto',
      inputSchema: { messageId: 'string', attachmentId: 'string', maxBytes: 'number' },
      hardCapAttachmentBytes: GMAIL_ATTACHMENT_DOWNLOAD_HARD_CAP_BYTES,
      notes:
        'Caller must declare an expected maxBytes; the router denies with attachment_cap_exceeded above ' +
        'GMAIL_ATTACHMENT_DOWNLOAD_HARD_CAP_BYTES regardless of any grant, and a grant\'s maxAttachmentBytes ' +
        'may narrow that further.',
    },
    {
      id: 'gmail.drafts.reply',
      operation: 'reply',
      resource: 'drafts',
      risk: 'write',
      sideEffect: 'draft',
      approval: 'auto',
      inputSchema: { threadId: 'string', messageId: 'string', to: 'string[]', body: 'string' },
      notes: 'Draft-first reply, mirrors gmail.drafts.create. Still requires gmail.drafts.send + approval to send.',
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
      inputSchema: { draftId: 'string', to: 'string[]?' },
      notes:
        'Draft-first send. Approval must bind the exact recipient/body/attachment hash and an idempotency key. ' +
        'Callers should declare `to` so the router can enforce recipient-domain grant scope at send time, not ' +
        'just at draft-create time; a scoped grant fails closed if `to` is omitted. Verifying `to` matches the ' +
        'underlying draft is Slice 5 (live backend) work — this slice only wires the policy-plane check.',
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
