# Gmail-first IDACC connector architecture

Goal: `goal_mqx09y9d_acrer`. Parent tracking task: `complete-idacc-connectors-release` (`#87e060ff`).

This is the landed design reference for `src/connectors/**`. It supersedes the
prose-only plan in `output/idacc-native-integrations-connectors-implementation-plan.md`
and `output/design-idacc-connector-architecture-slice-resume.md` — those set
the direction; this document and the code under `src/connectors/` are the
implementation of slices 0–3 of that plan (catalog, grants/policy/audit,
runtime router, backend ports), scoped to Gmail read/draft/approval-gated-send.

No OAuth secrets, mailbox grants, live email sends, or production deployment
happen anywhere in this slice. See [Staged rollout](#staged-rollout) for what
still requires explicit operator sign-off before any of that changes.

## Control-plane model

A connector manifest is an immutable, versioned, hash-checked contract
(`src/connectors/catalog/manifest-validator.ts`, `connector-registry.ts`).
Publishing a manifest never grants use. Execution requires, in order: a
published version, an active connection, an exact capability grant, and — for
risk-bearing capabilities — an approved approval request. Unknown capability
IDs, disabled connectors, hard-denied capabilities, and unpinned/ambiguous
backends fail closed.

### Registry schema

See `src/connectors/catalog/migrations.ts` for the authoritative DDL
(sqlite + postgres). Entities: `connectors`, `connector_versions`,
`connector_connections`, `connector_capability_grants`,
`connector_approval_policies`, `connector_approval_requests`,
`connector_invocations`, `connector_audit_events`. TypeScript shapes live in
`src/connectors/types.ts`.

## Default-deny routing order

Implemented in `src/connectors/runtime/router.ts` (`ConnectorRouter.route`):

1. **Feature-flag gate** — master switch, then the per-connector flag
   (`src/connectors/config/feature-flags.ts`). Off by default.
2. **Exact-pin capability resolution** — `ConnectorRegistry.resolveCapability`
   requires connector id + published version + capability id all present;
   any miss is `unknown_capability`, never a partial/latest match.
3. **Hard-deny check** — a capability with `hardDeny: true` in its manifest
   entry (e.g. `gmail.messages.send`) is denied before any grant is
   evaluated.
3b. **Capability-specific feature-flag gate** — beyond the per-connector
   flag, individual capabilities may require their own flag
   (`RouterDeps.capabilityFlagGate`, keyed by capability id). Gmail wires
   `CONNECTOR_CAPABILITY_FLAG_GATE` (`config/feature-flags.ts`) so
   `gmail.drafts.send` also requires `gmailSendEnabled`, independent of
   `gmailConnectorEnabled` gating the rest of the connector — this is what
   makes stage 3 (read/draft live, send still off) and stage 4 (send flipped
   for the pilot cohort) distinct, enforceable states rather than a single
   flag covering both. Whoever instantiates `ConnectorRouter` for a real
   deployment must pass this map; it is not wired automatically.
4. **Connection binding + status** — the connection must belong to the same
   agent/tenant/connector/version and be `active`.
5. **Argument shape validation** — runtime check against the manifest's
   `inputSchema` (`runtime/router.ts#validateArgs`); unknown fields,
   missing required fields, wrong primitive array/scalar types, and enum
   misses deny before touching a grant. Capabilities with an empty schema
   accept only an empty/missing args object.
5b. **Attachment byte hard cap** — a capability may declare
   `hardCapAttachmentBytes` in its manifest entry (currently
   `gmail.attachments.download`, capped at
   `GMAIL_ATTACHMENT_DOWNLOAD_HARD_CAP_BYTES`). The router denies with
   `attachment_cap_exceeded` above that ceiling regardless of any grant —
   a manifest-declared floor, not something a grant can widen. A grant's
   `resourceScope.maxAttachmentBytes` (step 6) may narrow the effective cap
   further per agent/tenant.
6. **Grant evaluation** — `grants/grant-evaluator.ts#evaluateGrant`.
   Deny-overrides-allow; absence of any grant is deny; expired/revoked grants
   are ignored for allow purposes. The router derives invocation resource
   context before evaluation (`accountRef` from the connection, recipient
   domains from `to`, read caps such as `maxResults`/`maxMessages`, and
   attachment size from `maxBytes`), so constrained grants fail closed when
   the invocation cannot prove it is inside scope. `gmail.drafts.send` now
   accepts an optional `to` for this same reason: a grant scoped by
   `recipientDomainsAllow` fails closed on send (not just on draft creation)
   if the caller omits `to`.
6b. **Side-effect idempotency key** — any capability whose manifest
   `sideEffect` is not `none` must supply an `idempotencyKey` before approval
   or backend dispatch. Missing keys deny with `idempotency_required`.
7. **Approval policy** — `policy/approval-policy.ts#resolveApprovalMode`. A
   capability's manifest approval mode is a floor; an
   `ApprovalPolicyRecord` may only make it stricter. `always`/`confirm`
   short-circuits to an `approval_required` result with a single-use
   `ApprovalRequestRecord` (`policy/approval-requests-repo.ts`) bound to the
   exact args hash; a second call must supply the approved request's id and
   a matching args hash to proceed. Conditional policy rows receive derived
   invocation context, including external-recipient and attachment signals,
   before the backend is considered.
8. **Idempotency guard + backend dispatch + audit** — a scoped replay
   (same request id, or same agent/tenant/connector/version/capability/
   connection/idempotency key with the same args hash) short-circuits to the
   previously recorded result instead of re-invoking the backend. Reusing an
   idempotency key with different args denies with `idempotency_conflict`.
   Otherwise the router resolves the
   manifest's `backend.binding` name to a reviewed origin/identity
   (`catalog/backend-bindings.ts`) — never from agent input — and calls the
   matching `ConnectorBackend.invoke`. Every branch, including every deny,
   appends one `connector_audit_events` row via `audit/audit-log.ts`
   (`ConnectorAuditLog`), which hash-chains each event to the previous one
   (`verifyChain()` detects tampering).

## Backend ports

`src/connectors/backends/connector-backend.ts` defines the `ConnectorBackend`
interface. OAuth/API/MCP is a transport choice the router treats uniformly —
policy is evaluated identically regardless of which backend ultimately
serves a capability.

- **`oauth-api-backend.ts`** (Gmail): ships with zero live network capability
  in this slice. `invoke` always calls through `CredentialBroker
  .withAccessToken`; the default `FakeVaultCredentialBroker`
  (`credentials/credential-broker.ts`) always throws before any token is
  resolved, so a real Gmail API call is structurally unreachable until a
  real vault-backed broker is wired in — an explicit, separate, later stage.
- **`mcp-backend.ts`** (reviewed MCP): builds on the existing per-agent MCP
  wiring in `src/harness/mcp.ts` (`McpServerSpec` → `toMcpServerRecord`,
  injected via `ID_MCP_SERVERS` at spawn) instead of a second MCP transport.
  Adds what that mechanism lacks: a pinned server allowlist keyed by
  manifest digest, a fixed capability→tool-name mapping, and a feature-flag
  gate evaluated before any server is attached. Dynamic discovery and
  agent-chosen `tools/call` names are unreachable through this adapter.
  Disabled by default (`mcpBackendEnabled: false`).

## Gmail-first capability set

`src/connectors/providers/gmail/gmail-manifest.ts` (`GMAIL_V1_MANIFEST`),
bootstrapped via `providers/gmail/bootstrap.ts`:

| Capability | Approval | Notes |
|---|---|---|
| `gmail.messages.search` / `.get`, `gmail.threads.get`, `gmail.labels.list`, `gmail.attachments.metadata` | `auto` | Read-only. `.get` is metadata/snippet only. |
| `gmail.messages.get_full` | `confirm` | Full message body. Split out of `.get`; also gated by `gmailFullBodyReadEnabled`. |
| `gmail.attachments.download` | `auto` | Read-only; hard-capped at `GMAIL_ATTACHMENT_DOWNLOAD_HARD_CAP_BYTES`, narrowable per grant via `maxAttachmentBytes`. |
| `gmail.drafts.create` / `.update` / `.reply` | `auto` | Draft-only, no send. `.reply` mirrors `.create` for a threaded reply. |
| `gmail.drafts.send` | `always` | Draft-first send; approval binds to the exact args hash. Accepts optional `to` so recipient-domain grant scope is enforced at send time too. |
| `gmail.messages.send`, `gmail.messages.trash`, `gmail.messages.delete`, `gmail.settings.forwarding` | `deny` (`hardDeny: true`) | Hard-denied at launch regardless of any grant. |

## Feature flags

`config/feature-flags/connectors.json`, loaded by
`src/connectors/config/feature-flags.ts` with `ID_CONNECTORS_*` env
overrides. All six flags default to `false`:
`connectorsEnabled`, `gmailConnectorEnabled`, `gmailSendEnabled`,
`gmailFullBodyReadEnabled`, `mcpBackendEnabled`, `connectorsMigrationsEnabled`.

## Staged rollout

The migrations in `src/connectors/catalog/migrations.ts` are wired into the
live boot chain (`src/db/index.ts` `migrateDb`, called after the core
`migrateSqlite`/`migratePostgres` chain) but gated behind
`connectorsMigrationsEnabled` (default `false`) — on every boot today this
is a no-op. Flipping that flag, enabling any other feature flag, registering
a real `CredentialBroker`, or pinning a real MCP server are each a separate,
operator-approved stage:

1. **Stage 0 (done)** — catalog/grants/policy/router/backends/audit code +
   tests, all flags off, no DB wiring into the live boot chain.
2. **Stage 1 (done, off by default)** — `migrateConnectorsSqlite`/
   `migrateConnectorsPostgres` are wired into `migrateDb`
   (`src/db/index.ts`) behind `connectorsMigrationsEnabled`. Flipping that
   flag to `true` is the operator-approved action that starts applying the
   additive `CREATE TABLE/INDEX IF NOT EXISTS` statements to the live
   manager DB on next restart — nothing else in this stage requires a code
   change. A durable operator-consent record for that sign-off (and future
   stage sign-offs) is captured by `connector_operator_consents`
   (`src/connectors/catalog/migrations.ts`,
   `src/connectors/catalog/operator-consent.ts`); recording consent does
   not itself flip any flag.
3. **Stage 2** — accept a vault/credential-broker choice and OAuth callback
   owner (see [Open decisions](#open-decisions)); implement a real
   `CredentialBroker` and register it in place of `FakeVaultCredentialBroker`.
   Still `gmailConnectorEnabled: false`.
4. **Stage 3** — flip `connectorsEnabled` + `gmailConnectorEnabled` for a
   named pilot agent/tenant only (via an explicit grant, not a global flag
   flip), with `gmailSendEnabled` still `false`. Implement the real Gmail API
   calls inside `OAuthApiBackend.invoke`.
5. **Stage 4** — pilot evidence review, then `gmailSendEnabled: true` for the
   same pilot cohort. `gmail.drafts.send` remains `always`-approval; direct
   send/trash/delete/settings remain hard-denied.
6. **Stage 5 (conditional)** — a specific, reviewed MCP server may be pinned
   into `mcp-backend.ts`'s `reviewedServers` and `mcpBackendEnabled` flipped,
   only after its manifest digest and tool mapping are reviewed.

### Rollback

Every stage above is a config/flag change or an additive migration, so
rollback at any stage is: flip the relevant flag back to `false`
(`config/feature-flags/connectors.json` or `ID_CONNECTORS_*` env), which the
router's step 1 check makes an immediate, total kill switch — no code
rollback needed. Revoking a specific grant
(`ConnectorGrantsRepo.revoke`) or connection
(`ConnectorConnectionsRepo.revoke`) is narrower and immediate. Table-level
rollback, if ever needed, is `downMigrateConnectorsSqlite` /
`downMigrateConnectorsPostgres` in `catalog/migrations.ts`, which only drops
the `connector_*` tables and touches nothing else.

## Open decisions

Resolved by this prerequisite slice (policy-plane only — no live wiring):
full message body access is now a distinct capability
(`gmail.messages.get_full`) behind its own flag and `confirm` approval,
separate from the metadata/snippet tier; attachment download is modeled as
`gmail.attachments.download` with a conservative hard cap
(`GMAIL_ATTACHMENT_DOWNLOAD_HARD_CAP_BYTES`, `10_000_000` bytes) pending
operator sign-off on a larger value once real traffic is observed; a
draft-first reply path (`gmail.drafts.reply`) exists alongside `.create`;
and `gmail.drafts.send` carries an optional `to` so recipient-domain grant
scope applies at send time, not only at draft-create time (verifying `to`
against the underlying draft's actual recipients is Stage 3/Slice 5 live
backend work, not this slice).

Still unresolved and explicitly out of scope for this slice: vault/credential
broker product and OAuth callback ownership; canonical tenant/agent identity
propagation through the agent gateway; exact Gmail OAuth scopes for read vs.
compose vs. send; the final attachment byte cap value for production
(current value is a conservative placeholder); which reviewed MCP server (if
any) is eligible after the first-party adapter; approval-UI ownership and
audit retention policy; pilot cohort and rollback owner.
