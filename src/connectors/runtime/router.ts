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
 *   6. grant evaluation (deny-overrides-allow)
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
import { evaluateGrant } from '../grants/grant-evaluator.js';
import type { ApprovalPolicyRepo } from '../policy/approval-policy-repo.js';
import type { ApprovalRequestsRepo } from '../policy/approval-requests-repo.js';
import { resolveApprovalMode } from '../policy/approval-policy.js';
import { ConnectorAuditLog, hashSanitizedArgs } from '../audit/audit-log.js';
import type { DbAdapter } from '../../db/db-adapter.js';
import type { CapabilityManifestEntry, ConnectorInvocation, ConnectorResult, DenyCode } from '../types.js';

export interface ApprovalContextInput {
  externalRecipient?: boolean;
  hasAttachment?: boolean;
}

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
}

function isOptionalField(schemaValue: unknown): boolean {
  return typeof schemaValue === 'string' && schemaValue.endsWith('?');
}

/** Minimal structural check: every declared required key present, no undeclared keys. Not a full JSON-schema validator by design — see manifest-validator.ts for the publish-time shape check. */
function validateArgs(capability: CapabilityManifestEntry, args: unknown): boolean {
  const schema = capability.inputSchema ?? {};
  const schemaKeys = Object.keys(schema);
  if (schemaKeys.length === 0) return true;
  if (typeof args !== 'object' || args === null) return false;
  const argKeys = Object.keys(args as Record<string, unknown>);

  for (const key of argKeys) {
    if (!schemaKeys.includes(key)) return false;
  }
  for (const key of schemaKeys) {
    if (!isOptionalField(schema[key]) && !argKeys.includes(key)) return false;
  }
  return true;
}

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

    // 6. Grant evaluation.
    const candidates = await this.deps.grants.listCandidates(invocation.agentId, invocation.tenantId, capability.id);
    const grantResult = evaluateGrant({
      agentId: invocation.agentId,
      tenantId: invocation.tenantId,
      capabilityId: capability.id,
      connectionId: invocation.connectionId,
      candidateGrants: candidates,
      now,
    });
    if (!grantResult.allowed) return deny(grantResult.denyCode ?? 'no_grant', version, capability.id);

    // 7. Approval policy.
    const policies = await this.deps.approvalPolicies.listForCapability(capability.id);
    const approvalContext: ApprovalContextInput = {};
    const approval = resolveApprovalMode(capability, invocation.agentId, invocation.tenantId, policies, approvalContext);
    const argsHash = hashSanitizedArgs(invocation.args);

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
    if (invocation.idempotencyKey) {
      const existing = await this.deps.db.query<{ status: string }>(
        `SELECT status FROM connector_invocations WHERE connector_id = $1 AND capability_id = $2 AND idempotency_key = $3`,
        [invocation.connectorId, capability.id, invocation.idempotencyKey],
      );
      if (existing.rows.length > 0) {
        return { status: existing.rows[0].status as ConnectorResult['status'], requestId: invocation.requestId };
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
        result.ok ? 'ok' : 'provider_error',
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
      decision: result.ok ? 'ok' : 'provider_error',
      denyCode: null,
      argsHash,
      timestamp: now,
    });

    if (!result.ok) {
      return {
        status: result.errorKind === 'retryable' ? 'retryable_error' : 'provider_error',
        requestId: invocation.requestId,
        errorMessage: result.errorMessage,
      };
    }
    return { status: 'ok', requestId: invocation.requestId, data: result.data };
  }
}
