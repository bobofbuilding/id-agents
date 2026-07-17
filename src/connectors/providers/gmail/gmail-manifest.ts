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
import type { ConnectorFeatureFlags } from '../../config/feature-flags.js';
import {
  buildCapabilityFlagGate,
  buildConnectorFlagGate,
  buildMailManifest,
  buildRecipientVerificationGate,
  grantableCapabilityIds,
  type MailProviderDefinition,
} from '../mail/mail-provider-adapter.js';

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

export const GMAIL_PROVIDER_DEFINITION: MailProviderDefinition<keyof ConnectorFeatureFlags> = {
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
  connectorFlag: 'gmailConnectorEnabled',
  // Beyond gmailConnectorEnabled: full-body reads and send each require
  // their own additional flag (see docs/connectors/gmail-first-connector-
  // architecture.md#feature-flags). Resolved into capability-id form by
  // GMAIL_CAPABILITY_FLAG_GATE below.
  flagGate: {
    'messages.get_full': 'gmailFullBodyReadEnabled',
    'drafts.send': 'gmailSendEnabled',
  },
  // Beyond gmailSendEnabled: when gmailSendRecipientVerificationEnabled is
  // also on, gmail.drafts.send binds authorization to the draft's actual
  // recipients (via a DraftRecipientsLookup keyed on canonical connection
  // identity) rather than only the caller-declared `to`. Off by default; see
  // runtime/router.ts step 5c and runtime/draft-recipients-lookup.ts.
  recipientVerificationFlag: {
    'drafts.send': 'gmailSendRecipientVerificationEnabled',
  },
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

/** `{ gmail: 'gmailConnectorEnabled' }` — feeds RouterDeps.connectorFlagGate. Derived from GMAIL_PROVIDER_DEFINITION.connectorFlag, not hand-duplicated. */
export const GMAIL_CONNECTOR_FLAG_GATE = buildConnectorFlagGate(GMAIL_PROVIDER_DEFINITION);

/**
 * Gmail's contribution to the capability-specific flag gate, derived from
 * GMAIL_PROVIDER_DEFINITION.flagGate rather than a hand-duplicated map of
 * capability-id strings — see config/feature-flags.ts
 * CONNECTOR_CAPABILITY_FLAG_GATE, which merges every registered provider's
 * export like this one.
 */
export const GMAIL_CAPABILITY_FLAG_GATE = buildCapabilityFlagGate(GMAIL_PROVIDER_DEFINITION);

/**
 * Gmail's contribution to the send recipient-verification gate, derived from
 * GMAIL_PROVIDER_DEFINITION.recipientVerificationFlag — see
 * config/feature-flags.ts CONNECTOR_RECIPIENT_VERIFICATION_GATE, which
 * merges every registered provider's export like this one, and
 * runtime/router.ts step 5c for where this is enforced.
 */
export const GMAIL_RECIPIENT_VERIFICATION_GATE = buildRecipientVerificationGate(GMAIL_PROVIDER_DEFINITION);
