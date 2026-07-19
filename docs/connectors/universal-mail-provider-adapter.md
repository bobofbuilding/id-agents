# Universal mail provider adapter

Companion to [gmail-first-connector-architecture.md](./gmail-first-connector-architecture.md),
which remains the authoritative reference for the control-plane model
(registry, grants, policy, router, audit) and the staged rollout. This doc
covers only the seam a new mail provider plugs into: `src/connectors/providers/mail/`.

## Why this exists

The Gmail-first slice (commits `c57777a`, `f05a8ac`, `1d73057`) built the
registry/grants/policy/router/audit layers already provider-neutral — they
operate purely on `ConnectorManifest` / `CapabilityManifestEntry` and
`capabilityId` + `resourceScope.accountRef`, never on a Gmail-specific type.
The only place Gmail was hard-coded was the manifest itself
(`providers/gmail/gmail-manifest.ts`), hand-written capability-by-capability.
This adapter extracts that capability set into a shared, provider-neutral
schema so a second provider is additive data, not a rewrite of the control
plane.

**Per-agent/account/action grants are untouched.** A provider's capabilities
are just more `capabilityId`s to grant against
(`src/connectors/grants/grant-evaluator.ts`, `grants-repo.ts`), scoped by
`resourceScope.accountRef` exactly the way Gmail's are today. Adding a
provider never changes the grant model, the approval-policy engine, or the
router's default-deny sequence.

## Contract

- `providers/mail/mail-schema.ts` — `MAIL_CAPABILITY_SCHEMA`: the universal,
  provider-neutral capability set (search/get/get_full/list messages &
  threads, folders, attachment metadata/download, draft create/update/reply/
  send, direct-send and destructive/account-control operations hard-denied).
  `get_full` and `attachments.download` carry their own approval/cap
  treatment — a provider sets its own conservative attachment byte ceiling
  via `capabilityOverrides` (see Gmail's
  `GMAIL_ATTACHMENT_DOWNLOAD_HARD_CAP_BYTES`). Order is significant —
  it is preserved into the generated manifest's `capabilities` array and
  therefore affects `manifestHash` (see `catalog/manifest-validator.ts`
  `hashManifest`/`canonicalize`, which sorts object keys but not array order).
- `providers/mail/mail-provider-adapter.ts` — `MailProviderDefinition` +
  `buildMailManifest()`: a provider supplies its `connectorId`, display
  metadata, `backend` (kind/provider/reviewed binding name — never a raw
  origin or secret), and optional per-schema-key `resourceAliases` /
  `idSuffixAliases` / `capabilityOverrides` (e.g. Gmail aliases the canonical
  `folders` resource to `labels`, and its account-control settings surface to
  `forwarding`). The generated capability id is always
  `${connectorId}.${resource}.${idSuffix}`.
- The same provider definition owns `connectorFlag`, `flagGate`, and optional
  `recipientVerificationFlag` declarations. `buildConnectorFlagGate`,
  `buildCapabilityFlagGate`, and `buildRecipientVerificationGate` resolve
  those schema keys to the provider's generated connector/capability ids and
  reject references to absent schema capabilities. Central configuration
  merges each provider's generated exports; it does not hand-transcribe the
  provider's capability ids.
- `grantableCapabilityIds(manifest)` — same "exclude hard-denied" helper
  Gmail's `GMAIL_GRANTABLE_CAPABILITY_IDS` used, now shared.
- `bootstrapMailConnector(registry, def, manifest, now?)` — thin wrapper
  around `ConnectorRegistry.registerConnector/draftVersion/publishVersion`,
  identical in effect to the pre-adapter `bootstrapGmailConnector`.

## Gmail as the reference implementation

`providers/gmail/gmail-manifest.ts` now builds `GMAIL_V1_MANIFEST` via
`buildMailManifest(GMAIL_PROVIDER_DEFINITION)` instead of a hand-written
object literal. `tests/unit/connectors/mail-provider-adapter.test.ts` pins the
adapter-built manifest against a frozen copy of the original hand-written
manifest and asserts deep equality and hash equality — so no migration,
grant, or audit-log row keyed on an existing `gmail.*` capability id is
affected by this refactor. The same test file also builds a synthetic second
provider (`acmemail`, never registered against a real registry, no backend
implementation) purely to prove the schema/builder generalizes: distinct
capability-id namespace, correct resource/id-suffix aliasing, and identical
risk/approval/hard-deny shape to Gmail's equivalent operations.

## Adding a real second provider (out of scope for this change)

Landing an actual second provider (e.g. Outlook/Graph, IMAP/SMTP, or a
reviewed MCP mail server) still requires, per the existing staged-rollout
discipline in gmail-first-connector-architecture.md:

1. A `MailProviderDefinition` (this doc's contract) plus any schema
   deviations the provider genuinely needs (`capabilityOverrides`).
2. A reviewed backend binding (`catalog/backend-bindings.ts`) — a new
   allowlisted origin requires the same code review as `google-gmail-v1`.
3. A `ConnectorBackend` implementation (`backends/`) with a real credential
   path — out of scope here; this change ships no OAuth, no credentials, no
   live network path, no mailbox access for any provider, same as the
   Gmail slice at launch.
4. Feature flags gating the new connector/capabilities off by default,
   declared on that provider definition and exported through the generated
   `connectorFlagGate` / `capabilityFlagGate` pattern already wired through
   `RouterDeps` (see `runtime/router.ts`). Promotion evidence must show that
   every generated capability id exists in the provider manifest, every flag
   name exists in the loaded `ConnectorFeatureFlags` shape, and all new
   persisted defaults are `false`.

None of steps 2–4 are implied or started by this change — it only
generalizes the manifest-shape half of the Gmail slice.

The provider-extensible gate implementation landed in `3a44275` and was
independently validated in manager Brain completion `memory:8989`: TypeScript,
the full unit suite, connector tests, default-false inventory, generated gate
resolution, and existing consent-key compatibility passed. This is mechanism
evidence only. A second provider remains backlog and still requires its own
operator-approved rollout record, credentials/scopes decision, backend and
negative tests; no provider is enabled by adding a definition or gate map.

## Reconciliation with the Gmail send-scope/read-tier/reply/attachment-cap slice

This adapter (`fbcfe1a`) and the Gmail send-scope, read-tier split, reply,
and attachment-cap prereqs slice (`eab5b0e`) were developed in parallel off
a shared ancestor (`d1aacce`) and landed together: `get_full`,
`attachments.download` (with `hardCapAttachmentBytes`), `drafts.reply`, and
`drafts.send`'s `to` field were folded into `MAIL_CAPABILITY_SCHEMA` (not
left as Gmail-only additions) so any future mail provider gets the same
read-tier split, attachment cap, and recipient-scoped send for free. Gmail's
capability-specific notes (e.g. referencing `gmailFullBodyReadEnabled` by
name) live in `GMAIL_PROVIDER_DEFINITION.capabilityOverrides`, not the
shared schema, since flag names are per-provider.
