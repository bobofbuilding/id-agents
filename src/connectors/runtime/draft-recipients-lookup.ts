// SPDX-License-Identifier: MIT
/**
 * Draft-recipient lookup port for send-time recipient verification (see
 * ConnectorRouter step 5c). This is an injected port the router calls
 * directly, not a capability invocation — recipient verification must never
 * re-enter router.route() (which would re-run grant/approval/audit for a
 * lookup that is itself part of evaluating grant/approval for the original
 * send).
 *
 * The router builds every DraftRecipientsQuery from the already-resolved,
 * already-validated ConnectionRecord (connection.agentId/tenantId/id), never
 * from unvalidated invocation.agentId/tenantId — so a lookup can never be
 * pointed at another agent's or tenant's draft by anything an agent supplies
 * in args. See ConnectorRouter step 5c in runtime/router.ts.
 *
 * NullDraftRecipientsLookup is the only implementation wired in this slice:
 * it always reports the draft as unavailable. Paired with
 * gmailSendRecipientVerificationEnabled defaulting to false, that makes this
 * whole seam a no-op today; if the flag is ever flipped on without also
 * wiring a real lookup, sends fail closed (denied) rather than silently
 * trusting caller-declared recipients. A real Gmail-backed implementation —
 * fetching the draft's actual recipients over the same reviewed Gmail API a
 * future `OAuthApiBackend.invoke` would use — is Stage 3/Slice 5 live-backend
 * work; see docs/connectors/gmail-first-connector-architecture.md#open-decisions.
 */

export interface DraftRecipientsQuery {
  connectorId: string;
  connectionId: string;
  agentId: string;
  tenantId: string;
  draftId: string;
}

export interface DraftRecipientsLookup {
  /** Resolves to the draft's actual recipient addresses, or null if the draft/connection is unknown or the lookup is unavailable. */
  getRecipients(query: DraftRecipientsQuery): Promise<string[] | null>;
}

export class NullDraftRecipientsLookup implements DraftRecipientsLookup {
  async getRecipients(): Promise<string[] | null> {
    return null;
  }
}
