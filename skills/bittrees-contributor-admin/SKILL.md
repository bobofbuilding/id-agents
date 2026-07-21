---
name: bittrees-contributor-admin
description: Review and administer local Bittrees contributor applications through server-authorized gov/research paths. Use when Codex needs a reviewer queue, bounded admin detail or summary, state review actions, or negative authority tests; never use it to select authority, deploy publicly, or grant capabilities.
metadata:
  source: local:codex
---

# Bittrees Contributor Admin

Use the injected local/test role service for contributor administration. Keep
reviewer eligibility and decision authority as separate server-side policy
lookups; never infer either from a wallet, agent name, team, request body, or
query parameter.

## Admin workflow

1. Resolve the reviewer from a verified server session. The local harness uses
   only its explicit test SIWE adapter; production integration must inject a
   finalized L2 SIWE/session resolver.
2. Query `GET /api/admin/role-applications` with an optional server-registered
   `roleId` or lane (`research`, `inc-ops-governance`). Query
   `GET /api/admin/role-applications/summary` for bounded counts. Query admin
   detail only after the policy check succeeds.
3. Use `PATCH /api/admin/role-applications/:id/review` with an optimistic
   `expectedVersion` and one supported action: `start_review`, `request_info`,
   `resume_review`, `approve`, or `reject`.
4. Record the returned server-derived reviewer, policy, authority, state,
   version, append-only review, and audit evidence. Retry conflicts only after
   reloading the application.

## Fail-closed decisions

- Missing/invalid reviewer eligibility returns denial; do not reveal another
  applicant's record through a detail endpoint.
- Missing or wrong-lane decision authority must hold final approve/reject in
  `pending_authority` and record an audit event. Never select an approver,
  quorum, delegation, or authority policy in this skill.
- Keep `approved` and `rejected` immutable. Approval is not provisioning:
  `capabilityGrant` remains null and provisioning remains `not_requested`.
- Preserve lane-to-role mapping from the server catalog and the gov/research
  admin integration points; do not accept client-supplied reviewer, role,
  wallet, authority, or capability fields.

## Local-only boundary

Use the loopback harness, dummy fixture policies, atomic mode-0600 JSON storage,
and local functional tests only. Do not add credentials, public routes,
deployment, migrations, shared database access, wallet/onchain execution,
XMTP, payments, uploads, or live API writes. Record unresolved authority,
storage, API, rate-limit, and release gates as blockers for the owning lane.
