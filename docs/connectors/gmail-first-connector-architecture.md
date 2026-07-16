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
4. **Connection binding + status** — the connection must belong to the same
   agent/tenant/connector/version and be `active`.
5. **Argument shape validation** — structural check against the manifest's
   `inputSchema` (`runtime/router.ts#validateArgs`); unknown or missing
   required fields deny before touching a grant.
6. **Grant evaluation** — `grants/grant-evaluator.ts#evaluateGrant`.
   Deny-overrides-allow; absence of any grant is deny; expired/revoked grants
   are ignored for allow purposes.
7. **Approval policy** — `policy/approval-policy.ts#resolveApprovalMode`. A
   capability's manifest approval mode is a floor; an
   `ApprovalPolicyRecord` may only make it stricter. `always`/`confirm`
   short-circuits to an `approval_required` result with a single-use
   `ApprovalRequestRecord` (`policy/approval-requests-repo.ts`) bound to the
   exact args hash; a second call must supply the approved request's id and
   a matching args hash to proceed.
8. **Idempotency guard + backend dispatch + audit** — a side-effecting call
   with an `idempotencyKey` short-circuits to the previously recorded result
   instead of re-invoking the backend. Otherwise the router resolves the
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
| `gmail.messages.search` / `.get`, `gmail.threads.get`, `gmail.labels.list`, `gmail.attachments.metadata` | `auto` | Read-only. |
| `gmail.drafts.create` / `.update` | `auto` | Draft-only, no send. |
| `gmail.drafts.send` | `always` | Draft-first send; approval binds to the exact args hash. |
| `gmail.messages.send`, `gmail.messages.trash`, `gmail.messages.delete`, `gmail.settings.forwarding` | `deny` (`hardDeny: true`) | Hard-denied at launch regardless of any grant. |

## Feature flags

`config/feature-flags/connectors.json`, loaded by
`src/connectors/config/feature-flags.ts` with `ID_CONNECTORS_*` env
overrides. All four flags default to `false`:
`connectorsEnabled`, `gmailConnectorEnabled`, `gmailSendEnabled`,
`mcpBackendEnabled`.

## Staged rollout

The migrations in `src/connectors/catalog/migrations.ts` are **not** wired
into `src/db/migrations/{sqlite,postgres}.ts`'s boot chain yet — they must be
called explicitly (tests do this today). Wiring them into the boot chain,
enabling any feature flag, registering a real `CredentialBroker`, or pinning
a real MCP server are each a separate, operator-approved stage:

1. **Stage 0 (done, this slice)** — catalog/grants/policy/router/backends/
   audit code + tests, all flags off, no DB wiring into the live boot chain.
2. **Stage 1** — wire `migrateConnectorsSqlite`/`migrateConnectorsPostgres`
   into the boot migration chain (additive `CREATE TABLE IF NOT EXISTS`
   only). Requires operator sign-off since it starts applying to the live
   manager DB on next restart.
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

Unresolved and explicitly out of scope for this slice: vault/credential
broker product and OAuth callback ownership; canonical tenant/agent identity
propagation through the agent gateway; exact Gmail OAuth scopes for read vs.
compose vs. send; whether full message body access is in the first pilot or
metadata/snippet only; whether attachment download is needed for the pilot;
which reviewed MCP server (if any) is eligible after the first-party
adapter; approval-UI ownership and audit retention policy; pilot cohort and
rollback owner.
