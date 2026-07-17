// SPDX-License-Identifier: MIT
/**
 * Connector runtime router. Implements the default-deny routing sequence
 * from docs/connectors/gmail-first-connector-architecture.md#default-deny-routing-order:
 *
 *   1. feature-flag gate (master switch + per-connector flag)
 *   2. exact-pin capability resolution (registry; unknown => deny)
 *   3. hard-deny check
 *   3b. capability-specific feature-flag gate (e.g. gmailSendEnabled)
 *   4. connection binding + status check
 *   5. argument shape validation
 *   5b. attachment byte hard cap (manifest-declared, grant-independent)
 *   5c. draft-recipient verification (provider-declared flag; binds send
 *       authorization to the draft's actual recipients, not only the
 *       caller-declared `to`, once wired — see RouterDeps.recipientVerificationGate)
 *   6. grant evaluation (deny-overrides-allow)
 *   6b. side-effect idempotency-key requirement
 *   7. approval policy (may short-circuit with approval_required)
 *   8. idempotency guard + backend dispatch + audit write
 *
 * Every branch that is not an explicit "ok" writes an audit event and
 * returns before touching a backend. Agent-supplied fields never choose the
 * backend/binding: `binding` and `backend` come only from the resolved
 * ConnectorVersionRecord's manifest.
 */

import type { ConnectorBackend } from '../backends/connector-backend.js';
import type { ConnectorFeatureFlags } from '../config/feature-flags.js';
import type { ConnectorRegistry } from '../catalog/connector-registry.js';
import { resolveBindingOrigin } from '../catalog/backend-bindings.js';
import type { ConnectorConnectionsRepo } from '../connections/connections-repo.js';
import type { ConnectorGrantsRepo } from '../grants/grants-repo.js';
import { evaluateGrant, type RequestedResource } from '../grants/grant-evaluator.js';
import type { ApprovalPolicyRepo } from '../policy/approval-policy-repo.js';
import type { ApprovalRequestsRepo } from '../policy/approval-requests-repo.js';
import { resolveApprovalMode, type ApprovalContext } from '../policy/approval-policy.js';
import { ConnectorAuditLog, hashSanitizedArgs } from '../audit/audit-log.js';
import type { DbAdapter } from '../../db/db-adapter.js';
import type { CapabilityManifestEntry, ConnectionRecord, ConnectorInvocation, ConnectorResult, DenyCode } from '../types.js';
import { NullDraftRecipientsLookup, type DraftRecipientsLookup } from './draft-recipients-lookup.js';

export interface RouterDeps {
  db: DbAdapter;
  registry: ConnectorRegistry;
  connections: ConnectorConnectionsRepo;
  grants: ConnectorGrantsRepo;
  approvalPolicies: ApprovalPolicyRepo;
  approvalRequests: ApprovalRequestsRepo;
  auditLog: ConnectorAuditLog;
  backends: Partial<Record<'oauth_api' | 'api_key' | 'mcp', ConnectorBackend>>;
  featureFlags: ConnectorFeatureFlags;
  /** connectorId -> flag name that must be true for that connector, beyond the master switch. */
  connectorFlagGate: Record<string, keyof ConnectorFeatureFlags>;
  /** capabilityId -> flag name that must be true for that specific capability, beyond its connector's flag. See CONNECTOR_CAPABILITY_FLAG_GATE. */
  capabilityFlagGate?: Record<string, keyof ConnectorFeatureFlags>;
  /**
   * capabilityId -> flag name that, when true, turns on step 5c draft-recipient
   * verification for that capability. See CONNECTOR_RECIPIENT_VERIFICATION_GATE.
   */
  recipientVerificationGate?: Record<string, keyof ConnectorFeatureFlags>;
  /**
   * Resolves a draft's actual recipients for step 5c. Defaults to
   * NullDraftRecipientsLookup (always "unavailable") when omitted, so
   * turning on a recipientVerificationGate flag without wiring a real
   * lookup fails closed rather than silently trusting caller-declared `to`.
   */
  draftRecipientsLookup?: DraftRecipientsLookup;
}

function isOptionalField(schemaValue: unknown): boolean {
  return typeof schemaValue === 'string' && schemaValue.endsWith('?');
}

function schemaBase(schemaValue: string): string {
  return isOptionalField(schemaValue) ? schemaValue.slice(0, -1) : schemaValue;
}

function matchesSchemaValue(schemaValue: unknown, value: unknown): boolean {
  if (typeof schemaValue !== 'string') return true;
  const expected = schemaBase(schemaValue);
  if (expected.includes('|')) return typeof value === 'string' && expected.split('|').includes(value);
  if (expected === 'string') return typeof value === 'string';
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'string[]') return Array.isArray(value) && value.every((item) => typeof item === 'string');
  return true;
}

/** Minimal runtime schema check: every required key present, no undeclared keys, and primitive/enum declarations match. */
function validateArgs(capability: CapabilityManifestEntry, args: unknown): boolean {
  const schema = capability.inputSchema ?? {};
  const schemaKeys = Object.keys(schema);
  if (schemaKeys.length === 0) {
    return args == null || (typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0);
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
  const argsRecord = args as Record<string, unknown>;
  const argKeys = Object.keys(argsRecord);

  for (const key of argKeys) {
    if (!schemaKeys.includes(key)) return false;
    if (!matchesSchemaValue(schema[key], argsRecord[key])) return false;
  }
  for (const key of schemaKeys) {
    if (!isOptionalField(schema[key]) && !Object.prototype.hasOwnProperty.call(argsRecord, key)) return false;
  }
  return true;
}

function asArgsRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
}

function stringArrayField(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Strips a `Display Name <addr>` wrapper down to the bare address; never throws on malformed input. */
function bareAddress(recipient: string): string {
  const trimmed = recipient.trim();
  const angleAddress = /<([^<>@\s]+@[^<>\s]+)>$/.exec(trimmed);
  return angleAddress?.[1] ?? trimmed;
}

function extractDomain(recipient: string): string | null {
  const match = /@([^@\s>]+)$/.exec(bareAddress(recipient));
  return match ? match[1].toLowerCase() : null;
}

function normalizeRecipientAddress(recipient: string): string {
  return bareAddress(recipient).toLowerCase();
}

function recipientDomainsFromList(recipients: string[]): string[] {
  const domains = new Set<string>();
  for (const recipient of recipients) {
    const domain = extractDomain(recipient);
    if (domain) domains.add(domain);
  }
  return [...domains];
}

function recipientDomainsFromArgs(args: Record<string, unknown>): string[] {
  return recipientDomainsFromList(stringArrayField(args, 'to'));
}

/** Order-independent, case-insensitive comparison of two recipient address lists. */
function sameRecipientSet(declared: string[], actual: string[]): boolean {
  const declaredSet = new Set(declared.map(normalizeRecipientAddress));
  const actualSet = new Set(actual.map(normalizeRecipientAddress));
  if (declaredSet.size !== actualSet.size) return false;
  for (const address of declaredSet) {
    if (!actualSet.has(address)) return false;
  }
  return true;
}

function attachmentBytesFromArgs(args: Record<string, unknown>): number | undefined {
  const value = args.maxBytes;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function hasAttachmentContext(args: Record<string, unknown>): boolean {
  if (args.hasAttachment === true) return true;
  if (typeof args.attachmentId === 'string' && args.attachmentId.trim().length > 0) return true;
  for (const key of ['attachments', 'attachmentIds']) {
    const value = args[key];
    if (Array.isArray(value) && value.length > 0) return true;
  }
  return false;
}

function deriveRequestedResource(
  connection: ConnectionRecord,
  args: unknown,
  /** When set (step 5c resolved the draft's actual recipients), authorization binds to these, not the caller-declared `to`. */
  verifiedRecipients?: string[],
): RequestedResource {
  const argsRecord = asArgsRecord(args);
  const recipientDomains = verifiedRecipients
    ? recipientDomainsFromList(verifiedRecipients)
    : recipientDomainsFromArgs(argsRecord);
  const requested: RequestedResource = {
    accountRef: connection.vaultCredentialRef ?? connection.id,
  };
  if (recipientDomains.length === 1) requested.recipientDomain = recipientDomains[0];
  if (recipientDomains.length > 0) requested.recipientDomains = recipientDomains;
  if (typeof argsRecord.label === 'string') requested.label = argsRecord.label;
  if (typeof argsRecord.maxResults === 'number') requested.maxResults = argsRecord.maxResults;
  if (typeof argsRecord.maxMessages === 'number') requested.maxResults = argsRecord.maxMessages;
  const attachmentBytes = attachmentBytesFromArgs(argsRecord);
  if (attachmentBytes !== undefined) requested.attachmentBytes = attachmentBytes;
  return requested;
}

function deriveApprovalContext(args: unknown, verifiedRecipients?: string[]): ApprovalContext {
  const argsRecord = asArgsRecord(args);
  const recipientDomains = verifiedRecipients
    ? recipientDomainsFromList(verifiedRecipients)
    : recipientDomainsFromArgs(argsRecord);
  return {
    externalRecipient: recipientDomains.length > 0,
    hasAttachment: hasAttachmentContext(argsRecord),
  };
}

/**
 * Backend errors can include provider diagnostics, credential metadata, or
 * request-derived values. The router is a caller-facing boundary, so expose
 * only the already-classified result status and never the backend text.
 */
function publicBackendErrorMessage(errorKind: 'retryable' | 'provider' | 'not_connected' | undefined): string {
  return errorKind === 'retryable'
    ? 'Connector backend is temporarily unavailable'
    : 'Connector backend request failed';
}

function requiresIdempotency(capability: CapabilityManifestEntry): boolean {
  return capability.sideEffect !== 'none';
}

const DEFAULT_DRAFT_RECIPIENTS_LOOKUP = new NullDraftRecipientsLookup();

export class ConnectorRouter {
  constructor(private readonly deps: RouterDeps) {}

  async route(invocation: ConnectorInvocation): Promise<ConnectorResult> {
    const now = Date.now();

    const deny = async (
      denyCode: DenyCode,
      connectorVersion = invocation.connectorVersion ?? 'unknown',
      capabilityId: string | null = invocation.capabilityId,
    ): Promise<ConnectorResult> => {
      await this.deps.auditLog.append({
        requestId: invocation.requestId,
        actorAgentId: invocation.agentId,
        action: 'connector.invoke',
        connectorId: invocation.connectorId,
        connectorVersion,
        capabilityId,
        decision: 'denied',
        denyCode,
        argsHash: hashSanitizedArgs(invocation.args),
        timestamp: now,
      });
      return { status: 'denied', requestId: invocation.requestId, denyCode };
    };

    const auditReplay = async (
      status: ConnectorResult['status'],
      connectorVersion: string,
      capabilityId: string,
      argsHash: string,
    ): Promise<ConnectorResult> => {
      await this.deps.auditLog.append({
        requestId: invocation.requestId,
        actorAgentId: invocation.agentId,
        action: 'connector.idempotent_replay',
        connectorId: invocation.connectorId,
        connectorVersion,
        capabilityId,
        decision: status,
        denyCode: null,
        argsHash,
        timestamp: now,
      });
      return { status, requestId: invocation.requestId };
    };

    // 1. Feature-flag gate.
    if (!this.deps.featureFlags.connectorsEnabled) return deny('feature_disabled');
    const gateFlag = this.deps.connectorFlagGate[invocation.connectorId];
    if (gateFlag && !this.deps.featureFlags[gateFlag]) return deny('feature_disabled');

    // 2. Exact-pin resolution.
    const version = invocation.connectorVersion;
    if (!version) return deny('unknown_capability');
    const resolved = await this.deps.registry.resolveCapability(invocation.connectorId, version, invocation.capabilityId);
    if (!resolved) return deny('unknown_capability', version);
    const { capability } = resolved;

    // 3. Hard-deny check.
    if (capability.hardDeny) return deny('capability_hard_denied', version, capability.id);

    // 3b. Capability-specific feature-flag gate (e.g. gmailSendEnabled gating
    // gmail.drafts.send beyond gmailConnectorEnabled).
    const capabilityGateFlag = this.deps.capabilityFlagGate?.[capability.id];
    if (capabilityGateFlag && !this.deps.featureFlags[capabilityGateFlag]) {
      return deny('feature_disabled', version, capability.id);
    }

    // 4. Connection binding + status.
    const connection = await this.deps.connections.getById(invocation.connectionId);
    if (
      !connection ||
      connection.agentId !== invocation.agentId ||
      connection.tenantId !== invocation.tenantId ||
      connection.connectorId !== invocation.connectorId ||
      connection.connectorVersion !== version ||
      connection.status !== 'active'
    ) {
      return deny('connection_not_active', version, capability.id);
    }

    // 5. Argument shape.
    if (!validateArgs(capability, invocation.args)) return deny('invalid_args', version, capability.id);

    // 5b. Attachment byte hard cap. Manifest-declared, so it applies even
    // with no grant at all — a grant's maxAttachmentBytes may narrow this
    // further in step 6, but never widen past it.
    if (capability.hardCapAttachmentBytes != null) {
      const requestedBytes = attachmentBytesFromArgs(asArgsRecord(invocation.args));
      if (requestedBytes == null || requestedBytes > capability.hardCapAttachmentBytes) {
        return deny('attachment_cap_exceeded', version, capability.id);
      }
    }

    // 5c. Draft-recipient verification. Provider-declared per capability
    // (RouterDeps.recipientVerificationGate); off unless that capability's
    // gate flag is true. When on, authorization for the rest of this
    // invocation binds to the draft's actual recipients — resolved by
    // querying draftRecipientsLookup with the already-validated `connection`
    // identity (never invocation.agentId/tenantId) — instead of only the
    // caller-declared `to`. A caller-declared `to` that disagrees with the
    // actual recipients is denied; omitting `to` falls back entirely to the
    // looked-up recipients for grant-scope and approval-context purposes.
    let verifiedRecipients: string[] | undefined;
    const verificationFlag = this.deps.recipientVerificationGate?.[capability.id];
    if (verificationFlag && this.deps.featureFlags[verificationFlag]) {
      const argsRecord = asArgsRecord(invocation.args);
      const draftId = typeof argsRecord.draftId === 'string' ? argsRecord.draftId : undefined;
      if (!draftId) return deny('invalid_args', version, capability.id);
      const lookup = this.deps.draftRecipientsLookup ?? DEFAULT_DRAFT_RECIPIENTS_LOOKUP;
      const actualRecipients = await lookup.getRecipients({
        connectorId: connection.connectorId,
        connectionId: connection.id,
        agentId: connection.agentId,
        tenantId: connection.tenantId,
        draftId,
      });
      if (!actualRecipients) return deny('draft_lookup_unavailable', version, capability.id);
      const declaredRecipients = stringArrayField(argsRecord, 'to');
      if (declaredRecipients.length > 0 && !sameRecipientSet(declaredRecipients, actualRecipients)) {
        return deny('recipient_mismatch', version, capability.id);
      }
      verifiedRecipients = actualRecipients;
    }

    // 6. Grant evaluation.
    const candidates = await this.deps.grants.listCandidates(invocation.agentId, invocation.tenantId, capability.id);
    const grantResult = evaluateGrant({
      agentId: invocation.agentId,
      tenantId: invocation.tenantId,
      capabilityId: capability.id,
      connectionId: invocation.connectionId,
      candidateGrants: candidates,
      now,
      requestedResource: deriveRequestedResource(connection, invocation.args, verifiedRecipients),
    });
    if (!grantResult.allowed) return deny(grantResult.denyCode ?? 'no_grant', version, capability.id);

    const argsHash = hashSanitizedArgs(invocation.args);

    // 6b. Side-effect idempotency requirement. Read-only calls may omit this;
    // draft/send/modify/delete-class calls must supply it before approval or
    // backend dispatch can be considered.
    if (requiresIdempotency(capability) && !invocation.idempotencyKey) {
      return deny('idempotency_required', version, capability.id);
    }

    // 7. Approval policy.
    const policies = await this.deps.approvalPolicies.listForCapability(capability.id);
    const approvalContext = deriveApprovalContext(invocation.args, verifiedRecipients);
    const approval = resolveApprovalMode(capability, invocation.agentId, invocation.tenantId, policies, approvalContext);

    if (approval.mode === 'deny') return deny('approval_denied', version, capability.id);

    if (approval.requiresApproval) {
      if (!invocation.approvalRequestId) {
        const request = await this.deps.approvalRequests.create({
          invocationRequestId: invocation.requestId,
          agentId: invocation.agentId,
          capabilityId: capability.id,
          argsHash,
          now,
        });
        await this.deps.auditLog.append({
          requestId: invocation.requestId,
          actorAgentId: invocation.agentId,
          action: 'connector.approval_required',
          connectorId: invocation.connectorId,
          connectorVersion: version,
          capabilityId: capability.id,
          decision: 'approval_required',
          denyCode: null,
          argsHash,
          timestamp: now,
        });
        return { status: 'approval_required', requestId: invocation.requestId, approvalRequestId: request.id };
      }

      const request = await this.deps.approvalRequests.getByInvocationRequestId(invocation.requestId);
      if (!request || request.id !== invocation.approvalRequestId || request.argsHash !== argsHash) {
        return deny('approval_denied', version, capability.id);
      }
      if (request.decision === 'expired' || request.expiresAt <= now) return deny('approval_expired', version, capability.id);
      if (request.decision !== 'approved') return deny('approval_denied', version, capability.id);
    }

    // 8. Idempotency guard + backend dispatch.
    const existingByRequestId = await this.deps.db.query<{ status: ConnectorResult['status']; args_hash: string | null }>(
      `SELECT status, args_hash FROM connector_invocations WHERE request_id = $1`,
      [invocation.requestId],
    );
    if (existingByRequestId.rows.length > 0) {
      const existing = existingByRequestId.rows[0];
      if (existing.args_hash !== argsHash) return deny('idempotency_conflict', version, capability.id);
      return auditReplay(existing.status, version, capability.id, argsHash);
    }

    if (invocation.idempotencyKey) {
      const existing = await this.deps.db.query<{ status: ConnectorResult['status']; args_hash: string | null }>(
        `SELECT status, args_hash FROM connector_invocations
         WHERE agent_id = $1 AND tenant_id = $2 AND connector_id = $3 AND connector_version = $4
           AND capability_id = $5 AND connection_id = $6 AND idempotency_key = $7`,
        [
          invocation.agentId,
          invocation.tenantId,
          invocation.connectorId,
          version,
          capability.id,
          invocation.connectionId,
          invocation.idempotencyKey,
        ],
      );
      if (existing.rows.length > 0) {
        const existingRow = existing.rows[0];
        if (existingRow.args_hash !== argsHash) return deny('idempotency_conflict', version, capability.id);
        return auditReplay(existingRow.status, version, capability.id, argsHash);
      }
    }

    const backend = this.deps.backends[resolved.version.backendKind];
    if (!backend) return deny('backend_not_allowlisted', version, capability.id);

    // The manifest only ever carries a stable binding *name*; oauth_api
    // bindings resolve that name to a reviewed origin here (never
    // agent-supplied). mcp/api_key backends key their own allowlist by the
    // binding name directly — see backends/mcp-backend.ts.
    const bindingName = resolved.version.manifest.backend.binding;
    const allowlistedOrigin =
      resolved.version.backendKind === 'oauth_api' ? resolveBindingOrigin(bindingName) : bindingName;
    if (!allowlistedOrigin) return deny('backend_not_allowlisted', version, capability.id);

    try {
      await backend.validateBinding({
        name: bindingName,
        kind: resolved.version.backendKind,
        allowlistedOrigin,
      });
    } catch {
      return deny('backend_not_allowlisted', version, capability.id);
    }

    const result = await backend.invoke({ capability, connection, args: invocation.args, requestId: invocation.requestId });
    const resultStatus: ConnectorResult['status'] = result.ok
      ? 'ok'
      : result.errorKind === 'retryable'
        ? 'retryable_error'
        : 'provider_error';

    await this.deps.db.query(
      `INSERT INTO connector_invocations (
        request_id, idempotency_key, agent_id, tenant_id, connector_id, connector_version, capability_id,
        connection_id, status, deny_code, args_hash, created_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        invocation.requestId,
        invocation.idempotencyKey ?? null,
        invocation.agentId,
        invocation.tenantId,
        invocation.connectorId,
        version,
        capability.id,
        invocation.connectionId,
        resultStatus,
        null,
        argsHash,
        now,
        Date.now(),
      ],
    );

    await this.deps.auditLog.append({
      requestId: invocation.requestId,
      actorAgentId: invocation.agentId,
      action: 'connector.invoke',
      connectorId: invocation.connectorId,
      connectorVersion: version,
      capabilityId: capability.id,
      decision: resultStatus,
      denyCode: null,
      argsHash,
      timestamp: now,
    });

    if (!result.ok) {
      return {
        status: result.errorKind === 'retryable' ? 'retryable_error' : 'provider_error',
        requestId: invocation.requestId,
        errorMessage: publicBackendErrorMessage(result.errorKind),
      };
    }
    return { status: 'ok', requestId: invocation.requestId, data: result.data };
  }
}
