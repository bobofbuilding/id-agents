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
    inputSchema: { messageId: 'string', format: 'metadata|snippet|full' },
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
    inputSchema: { draftId: 'string' },
    notes: 'Draft-first send. Approval must bind the exact recipient/body/attachment hash and an idempotency key.',
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
