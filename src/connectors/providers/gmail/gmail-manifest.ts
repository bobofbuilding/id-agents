// SPDX-License-Identifier: MIT
/**
 * Gmail v1 connector manifest. Data only — no network code, no credentials.
 * Mirrors the capability set frozen in
 * docs/connectors/gmail-first-connector-architecture.md#gmail-first-capability-set.
 *
 * Generated through buildMailManifest() against the universal mail schema
 * (see providers/mail/mail-schema.ts, providers/mail/mail-provider-adapter.ts)
 * rather than hand-written. Keep the underlying schema intentionally small at
 * launch: read + draft-first, with send behind mandatory approval and
 * destructive/account-control operations hard-denied. Expanding it is a
 * schema version bump, not an edit here.
 */

import type { ConnectorManifest } from '../../types.js';
import { buildMailManifest, grantableCapabilityIds, type MailProviderDefinition } from '../mail/mail-provider-adapter.js';

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
  capabilityOverrides: {
    'messages.get': {
      notes: 'Metadata/snippet only. Full body is a separate, stricter capability — see gmail.messages.get_full.',
    },
    'attachments.download': {
      hardCapAttachmentBytes: GMAIL_ATTACHMENT_DOWNLOAD_HARD_CAP_BYTES,
      notes:
        'Caller must declare an expected maxBytes; the router denies with attachment_cap_exceeded above ' +
        "GMAIL_ATTACHMENT_DOWNLOAD_HARD_CAP_BYTES regardless of any grant, and a grant's maxAttachmentBytes " +
        'may narrow that further.',
    },
    'messages.get_full': {
      notes:
        'Full message body content. Split out of gmail.messages.get and gated behind its own feature flag ' +
        '(gmailFullBodyReadEnabled, off by default) plus per-invocation confirmation — full body is materially ' +
        'more sensitive than metadata/snippet reads.',
    },
    'drafts.reply': {
      notes: 'Draft-first reply, mirrors gmail.drafts.create. Still requires gmail.drafts.send + approval to send.',
    },
    'drafts.send': {
      notes:
        'Draft-first send. Approval must bind the exact recipient/body/attachment hash and an idempotency key. ' +
        'Callers should declare `to` so the router can enforce recipient-domain grant scope at send time, not ' +
        'just at draft-create time; a scoped grant fails closed if `to` is omitted. Verifying `to` matches the ' +
        'underlying draft is Slice 5 (live backend) work — this slice only wires the policy-plane check.',
    },
  },
};

export const GMAIL_V1_MANIFEST: ConnectorManifest = buildMailManifest(GMAIL_PROVIDER_DEFINITION);

/** Capability ids that a grant may reference at launch (excludes hard-denied entries). */
export const GMAIL_GRANTABLE_CAPABILITY_IDS = grantableCapabilityIds(GMAIL_V1_MANIFEST);
