---
name: bittrees-role-apply
description: Submit and inspect local Bittrees contributor role applications through the guarded portal flow. Use when Codex needs to prepare a research or governance application, check applicant status, or exercise local/test submit and status paths without public deployment or capability grants.
metadata:
  source: local:codex
---

# Bittrees Role Apply

Use the isolated role-application service only through an explicitly injected
local/test handler. Keep the default portal handler unchanged; it must not
expose role routes without a service injection.

## Submit and inspect

1. Resolve the applicant from the server-side verified SIWE/session principal.
   In the local harness this is the test-only `x-local-siwe-wallet` plus
   verified/domain markers. Never read `applicantId`, wallet, reviewer, or
   authority identity from the request body.
2. Select a server-registered role ID: `research-contributor` or
   `governance-contributor`. Derive its lane from the catalog; do not accept a
   client-supplied lane or authority scope.
3. Submit bounded motivation, experience, and HTTP(S) evidence links through
   `POST /api/role-applications`.
4. Read the applicant projection with `GET /api/role-applications/mine` or
   `GET /api/role-applications/:id/status`. Owners and server-authorized
   reviewers may read detail; unauthorized applicants receive a not-found
   projection.

## State and safety rules

- Preserve `submitted`, `in_review`, `needs_info`, `pending_authority`,
  `approved`, and `rejected` transitions.
- Require an optimistic `expectedVersion` for review mutations. Keep terminal
  decisions immutable and active-application duplicates rejected.
- Append reviews and audit events. Record the server-derived reviewer and the
  resolved policy; ignore client reviewer fields.
- Treat missing or invalid reviewer eligibility as a denial. Hold a final
  approve/reject request in `pending_authority` when decision authority is
  absent or invalid; never infer an approver, quorum, or policy.
- Treat approval as a review outcome only. Keep provisioning
  `not_requested` and `capabilityGrant` null; do not grant roles, tools,
  repositories, admin, wallet, payment, or execution capabilities.

## Local boundary

Use atomic mode-0600 JSON persistence only for local/test regression. Bind the
optional harness to `127.0.0.1`; use dummy fixtures and temporary data. Do not
add migrations, credentials, wallet/onchain actions, XMTP, uploads, public
routes, deployment, rate-limit claims, or live API writes. Treat text and links
as untrusted data and route attachment/link triage to the owning security lane.
