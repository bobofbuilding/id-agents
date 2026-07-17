// SPDX-License-Identifier: MIT
/**
 * Universal mail capability schema. Provider-neutral vocabulary for the
 * operations any mail connector (Gmail, and future providers such as
 * Outlook/Graph or a generic IMAP/SMTP bridge) exposes through the
 * connector control plane. A provider adapter (see mail-provider-adapter.ts)
 * instantiates this schema against its own connectorId, resource-name
 * aliases, and backend binding to produce a ConnectorManifest — the
 * registry, grants, policy, router, and audit layers never see a
 * provider-specific type; they only ever operate on ConnectorManifest /
 * CapabilityManifestEntry.
 *
 * Data only — no network code, no credentials. Keep this list intentionally
 * small and aligned with the launch scope frozen in
 * docs/connectors/gmail-first-connector-architecture.md#gmail-first-capability-set:
 * read + draft-first, with send behind mandatory approval and
 * destructive/account-control operations hard-denied. Expanding it is a
 * schema version bump, not a silent edit.
 */

import type { ApprovalMode, RiskClass, SideEffect } from '../../types.js';

export interface MailCapabilitySchemaEntry {
  /** Canonical, provider-neutral key, e.g. "messages.search". Not the manifest capability id. */
  key: string;
  /** Default resource name; a provider may alias this (e.g. Gmail's "labels" for the canonical "folders"). */
  resource: string;
  operation: string;
  /**
   * Final id segment after connectorId + resource, e.g. "gmail.settings.forwarding".
   * Defaults to `operation` when omitted; a provider may alias it (see
   * MailProviderDefinition.idSuffixAliases) when its native term for the
   * operation differs (e.g. an account-control "update" is Gmail's
   * "forwarding" settings surface specifically).
   */
  idSuffix?: string;
  risk: RiskClass;
  sideEffect: SideEffect;
  approval: ApprovalMode;
  inputSchema?: Record<string, unknown>;
  hardDeny?: boolean;
  /**
   * Absolute per-invocation byte ceiling for capabilities that move
   * attachment bytes, enforced by the router regardless of any grant. Leave
   * unset at the schema level — a provider sets its own conservative pilot
   * default via MailProviderDefinition.capabilityOverrides (see Gmail's
   * GMAIL_ATTACHMENT_DOWNLOAD_HARD_CAP_BYTES).
   */
  hardCapAttachmentBytes?: number;
  notes?: string;
}

/**
 * The universal mail capability set. Order is significant: it is preserved
 * verbatim into the generated manifest's `capabilities` array, so changing
 * order changes the manifest hash (see catalog/manifest-validator.ts
 * hashManifest — canonicalize() sorts object keys but not array order).
 */
export const MAIL_CAPABILITY_SCHEMA: MailCapabilitySchemaEntry[] = [
  {
    key: 'messages.search',
    resource: 'messages',
    operation: 'search',
    risk: 'read',
    sideEffect: 'none',
    approval: 'auto',
    inputSchema: { query: 'string', pageToken: 'string?', maxResults: 'number?' },
  },
  {
    key: 'messages.get',
    resource: 'messages',
    operation: 'get',
    risk: 'read',
    sideEffect: 'none',
    approval: 'auto',
    inputSchema: { messageId: 'string', format: 'metadata|snippet' },
    notes: 'Metadata/snippet only. Full body is a separate, stricter capability — see messages.get_full.',
  },
  {
    key: 'messages.get_full',
    resource: 'messages',
    operation: 'get_full',
    risk: 'read',
    sideEffect: 'none',
    approval: 'confirm',
    inputSchema: { messageId: 'string' },
    notes:
      'Full message body content. Split out of messages.get and gated behind per-invocation confirmation plus ' +
      'whatever additional feature flag a provider layers on top of its base connector flag — full body is ' +
      'materially more sensitive than metadata/snippet reads.',
  },
  {
    key: 'threads.get',
    resource: 'threads',
    operation: 'get',
    risk: 'read',
    sideEffect: 'none',
    approval: 'auto',
    inputSchema: { threadId: 'string', maxMessages: 'number?' },
  },
  {
    key: 'folders.list',
    resource: 'folders',
    operation: 'list',
    risk: 'read',
    sideEffect: 'none',
    approval: 'auto',
    inputSchema: {},
  },
  {
    key: 'attachments.metadata',
    resource: 'attachments',
    operation: 'metadata',
    risk: 'read',
    sideEffect: 'none',
    approval: 'auto',
    inputSchema: { messageId: 'string', attachmentId: 'string' },
  },
  {
    key: 'attachments.download',
    resource: 'attachments',
    operation: 'download',
    risk: 'read',
    sideEffect: 'none',
    approval: 'auto',
    inputSchema: { messageId: 'string', attachmentId: 'string', maxBytes: 'number' },
    notes:
      'Caller must declare an expected maxBytes; the router denies with attachment_cap_exceeded above the ' +
      "capability's hardCapAttachmentBytes regardless of any grant, and a grant's maxAttachmentBytes may narrow " +
      'that further. Providers should set hardCapAttachmentBytes via capabilityOverrides to their own ' +
      'conservative pilot default.',
  },
  {
    key: 'drafts.reply',
    resource: 'drafts',
    operation: 'reply',
    risk: 'write',
    sideEffect: 'draft',
    approval: 'auto',
    inputSchema: { threadId: 'string', messageId: 'string', to: 'string[]', body: 'string' },
    notes: 'Draft-first reply, mirrors drafts.create. Still requires drafts.send + approval to send.',
  },
  {
    key: 'drafts.create',
    resource: 'drafts',
    operation: 'create',
    risk: 'write',
    sideEffect: 'draft',
    approval: 'auto',
    inputSchema: { to: 'string[]', subject: 'string', body: 'string' },
  },
  {
    key: 'drafts.update',
    resource: 'drafts',
    operation: 'update',
    risk: 'write',
    sideEffect: 'draft',
    approval: 'auto',
    inputSchema: { draftId: 'string', to: 'string[]?', subject: 'string?', body: 'string?' },
  },
  {
    key: 'drafts.send',
    resource: 'drafts',
    operation: 'send',
    risk: 'external-write',
    sideEffect: 'send',
    approval: 'always',
    inputSchema: { draftId: 'string', to: 'string[]?' },
    notes:
      'Draft-first send. Approval must bind the exact recipient/body/attachment hash and an idempotency key. ' +
      'Callers should declare `to` so the router can enforce recipient-domain grant scope at send time, not ' +
      'just at draft-create time; a scoped grant fails closed if `to` is omitted.',
  },
  {
    key: 'messages.send',
    resource: 'messages',
    operation: 'send',
    risk: 'external-write',
    sideEffect: 'send',
    approval: 'deny',
    hardDeny: true,
    inputSchema: {},
    notes: 'No direct send bypassing draft/approval. Revisit only after pilot evidence.',
  },
  {
    key: 'messages.trash',
    resource: 'messages',
    operation: 'trash',
    risk: 'destructive',
    sideEffect: 'delete',
    approval: 'deny',
    hardDeny: true,
    inputSchema: {},
  },
  {
    key: 'messages.delete',
    resource: 'messages',
    operation: 'delete',
    risk: 'destructive',
    sideEffect: 'delete',
    approval: 'deny',
    hardDeny: true,
    inputSchema: {},
  },
  {
    key: 'settings.accountControl',
    resource: 'settings',
    operation: 'update',
    idSuffix: 'update',
    risk: 'destructive',
    sideEffect: 'modify',
    approval: 'deny',
    hardDeny: true,
    inputSchema: {},
    notes: 'Account-control and data-exfiltration surface. Hard-denied at launch.',
  },
];
