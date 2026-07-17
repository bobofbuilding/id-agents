// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { hashManifest, validateConnectorManifest } from '../../../src/connectors/catalog/manifest-validator.js';
import {
  GMAIL_CONNECTOR_ID,
  GMAIL_GRANTABLE_CAPABILITY_IDS,
  GMAIL_MANIFEST_VERSION,
  GMAIL_RECIPIENT_VERIFICATION_GATE,
  GMAIL_V1_MANIFEST,
} from '../../../src/connectors/providers/gmail/gmail-manifest.js';
import {
  buildCapabilityFlagGate,
  buildConnectorFlagGate,
  buildMailManifest,
  buildRecipientVerificationGate,
  grantableCapabilityIds,
  type MailProviderDefinition,
} from '../../../src/connectors/providers/mail/mail-provider-adapter.js';
import type { ConnectorManifest } from '../../../src/connectors/types.js';

/**
 * Frozen copy of the hand-written Gmail v1 manifest this adapter replaced
 * (pre-adapter commit eab5b0e, the last hand-written state before
 * generalizing onto the universal mail schema). Asserting the adapter-built
 * manifest is deep-equal (and therefore hash-equal) to this fixture is the
 * regression guard: it proves generalizing Gmail onto the universal mail
 * schema did not change a single capability id, field, or the manifest hash
 * that existing migrations/grants/audit rows are keyed on.
 */
const PRE_ADAPTER_GMAIL_MANIFEST: ConnectorManifest = {
  connectorId: 'gmail',
  version: '1.0.0',
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
      hardCapAttachmentBytes: 10_000_000,
      notes:
        'Caller must declare an expected maxBytes; the router denies with attachment_cap_exceeded above ' +
        "GMAIL_ATTACHMENT_DOWNLOAD_HARD_CAP_BYTES regardless of any grant, and a grant's maxAttachmentBytes " +
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

describe('gmail manifest built through the universal mail provider adapter', () => {
  it('is capability-id/field identical to the pre-adapter hand-written manifest', () => {
    expect(GMAIL_V1_MANIFEST).toEqual(PRE_ADAPTER_GMAIL_MANIFEST);
  });

  it('hashes identically to the pre-adapter manifest', () => {
    expect(hashManifest(GMAIL_V1_MANIFEST)).toEqual(hashManifest(PRE_ADAPTER_GMAIL_MANIFEST));
  });

  it('still passes manifest validation', () => {
    const result = validateConnectorManifest(GMAIL_V1_MANIFEST);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('exposes the same grantable capability ids as before (hard-denied ids excluded)', () => {
    expect(GMAIL_GRANTABLE_CAPABILITY_IDS).toEqual(
      PRE_ADAPTER_GMAIL_MANIFEST.capabilities.filter((c) => !c.hardDeny).map((c) => c.id),
    );
    expect(GMAIL_GRANTABLE_CAPABILITY_IDS).not.toContain('gmail.messages.send');
    expect(GMAIL_GRANTABLE_CAPABILITY_IDS).not.toContain('gmail.settings.forwarding');
  });

  it('round-trips connectorId/version through the shared builder', () => {
    expect(GMAIL_V1_MANIFEST.connectorId).toEqual(GMAIL_CONNECTOR_ID);
    expect(GMAIL_V1_MANIFEST.version).toEqual(GMAIL_MANIFEST_VERSION);
  });

  it('declares send recipient-verification only for gmail.drafts.send, resolved from the same manifest aliasing', () => {
    expect(GMAIL_RECIPIENT_VERIFICATION_GATE).toEqual({
      'gmail.drafts.send': 'gmailSendRecipientVerificationEnabled',
    });
  });
});

describe('a second, hypothetical mail provider built on the same adapter', () => {
  const ACME_DEF: MailProviderDefinition<string> = {
    connectorId: 'acmemail',
    version: '1.0.0',
    displayName: 'Acme Mail',
    description: 'Synthetic second provider used only to prove the adapter generalizes beyond Gmail.',
    owner: 'idacc-connectors',
    trustTier: 'evaluation',
    backend: { kind: 'api_key', provider: 'acme', binding: 'acme-mail-v1' },
    resourceAliases: { 'folders.list': 'mailboxes' },
    idSuffixAliases: { 'settings.accountControl': 'auto_forward' },
    connectorFlag: 'acmeConnectorEnabled',
    flagGate: {
      'messages.get_full': 'acmeFullBodyReadEnabled',
      'drafts.send': 'acmeSendEnabled',
    },
    recipientVerificationFlag: {
      'drafts.send': 'acmeSendRecipientVerificationEnabled',
    },
  };
  const ACME_MANIFEST = buildMailManifest(ACME_DEF);

  it('produces a manifest that passes structural validation with no router/grants/policy code changes', () => {
    const result = validateConnectorManifest(ACME_MANIFEST);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('namespaces every capability id under its own connectorId, distinct from gmail', () => {
    for (const capability of ACME_MANIFEST.capabilities) {
      expect(capability.id.startsWith('acmemail.')).toBe(true);
    }
    const gmailIds = new Set(GMAIL_V1_MANIFEST.capabilities.map((c) => c.id));
    for (const capability of ACME_MANIFEST.capabilities) {
      expect(gmailIds.has(capability.id)).toBe(false);
    }
  });

  it('applies the provider resource/id-suffix aliases', () => {
    const foldersCapability = ACME_MANIFEST.capabilities.find((c) => c.operation === 'list' && c.resource === 'mailboxes');
    expect(foldersCapability?.id).toEqual('acmemail.mailboxes.list');
    const accountControlCapability = ACME_MANIFEST.capabilities.find((c) => c.resource === 'settings');
    expect(accountControlCapability?.id).toEqual('acmemail.settings.auto_forward');
  });

  it('carries the same risk/approval/hardDeny shape as Gmail for equivalent operations (grants model is untouched)', () => {
    const gmailSend = GMAIL_V1_MANIFEST.capabilities.find((c) => c.id === 'gmail.drafts.send')!;
    const acmeSend = ACME_MANIFEST.capabilities.find((c) => c.id === 'acmemail.drafts.send')!;
    expect(acmeSend.risk).toEqual(gmailSend.risk);
    expect(acmeSend.sideEffect).toEqual(gmailSend.sideEffect);
    expect(acmeSend.approval).toEqual(gmailSend.approval);

    const gmailHardDenyIds = GMAIL_V1_MANIFEST.capabilities.filter((c) => c.hardDeny).map((c) => c.operation + '.' + c.resource);
    const acmeHardDenyIds = ACME_MANIFEST.capabilities.filter((c) => c.hardDeny).map((c) => c.operation + '.' + c.resource);
    expect(acmeHardDenyIds.sort()).toEqual(gmailHardDenyIds.sort());
  });

  it('excludes hard-denied capabilities from the grantable set, same as Gmail', () => {
    const grantable = grantableCapabilityIds(ACME_MANIFEST);
    expect(grantable).not.toContain('acmemail.messages.send');
    expect(grantable).not.toContain('acmemail.settings.auto_forward');
    expect(grantable.length).toEqual(ACME_MANIFEST.capabilities.length - ACME_MANIFEST.capabilities.filter((c) => c.hardDeny).length);
  });

  it('declares its own connector-level and capability-level flag gate with no shared code changes', () => {
    expect(buildConnectorFlagGate(ACME_DEF)).toEqual({ acmemail: 'acmeConnectorEnabled' });
    expect(buildCapabilityFlagGate(ACME_DEF)).toEqual({
      'acmemail.messages.get_full': 'acmeFullBodyReadEnabled',
      'acmemail.drafts.send': 'acmeSendEnabled',
    });
  });

  it('resolves flag-gate entries through the same resource/id-suffix aliasing as the manifest, never a stale id', () => {
    const gate = buildCapabilityFlagGate({
      ...ACME_DEF,
      flagGate: { 'settings.accountControl': 'acmeAccountControlEnabled' },
    });
    expect(gate).toEqual({ 'acmemail.settings.auto_forward': 'acmeAccountControlEnabled' });
  });

  it("is isolated from Gmail's flag gate — a second provider never widens or narrows Gmail's own flags", () => {
    expect(buildCapabilityFlagGate(ACME_DEF)).not.toHaveProperty('gmail.drafts.send');
    expect(buildCapabilityFlagGate(ACME_DEF)).not.toHaveProperty('gmail.messages.get_full');
  });

  it('declares its own send recipient-verification gate with no shared code changes', () => {
    expect(buildRecipientVerificationGate(ACME_DEF)).toEqual({
      'acmemail.drafts.send': 'acmeSendRecipientVerificationEnabled',
    });
  });

  it("is isolated from Gmail's recipient-verification gate — a second provider never widens or narrows Gmail's own flag", () => {
    expect(buildRecipientVerificationGate(ACME_DEF)).not.toHaveProperty('gmail.drafts.send');
    expect(GMAIL_RECIPIENT_VERIFICATION_GATE).not.toHaveProperty('acmemail.drafts.send');
  });
});
