// SPDX-License-Identifier: MIT
/**
 * Core types for the IDACC connector control plane (registry, grants,
 * policy, runtime router, backends, audit).
 *
 * See docs/connectors/gmail-first-connector-architecture.md for the design
 * rationale. This module intentionally carries no provider SDKs, secrets, or
 * network code — it is the shared vocabulary every connector subsystem
 * imports.
 */

export type ConnectorStatus = 'draft' | 'published' | 'deprecated' | 'disabled';
export type ConnectorVersionStatus = 'draft' | 'review' | 'published' | 'deprecated' | 'revoked';
export type BackendKind = 'oauth_api' | 'api_key' | 'mcp';
export type RiskClass = 'read' | 'write' | 'external-write' | 'destructive';
export type SideEffect = 'none' | 'draft' | 'send' | 'modify' | 'delete';
export type ApprovalMode = 'auto' | 'confirm' | 'always' | 'deny';
export type GrantEffect = 'allow' | 'deny';

export interface CapabilityManifestEntry {
  /** Stable, namespaced capability id, e.g. "gmail.messages.search". */
  id: string;
  operation: string;
  resource: string;
  risk: RiskClass;
  sideEffect: SideEffect;
  /** Default approval mode; an ApprovalPolicy row may make this stricter, never looser. */
  approval: ApprovalMode;
  /** JSON-schema-ish description of accepted input shape (validated at runtime by isValidArgs). */
  inputSchema?: Record<string, unknown>;
  /** true when the capability is hard-denied at launch regardless of any grant. */
  hardDeny?: boolean;
  notes?: string;
}

export interface ConnectorManifest {
  connectorId: string;
  version: string;
  backend: {
    kind: BackendKind;
    provider: string;
    /** Name of the reviewed backend binding this version routes through. */
    binding: string;
  };
  capabilities: CapabilityManifestEntry[];
}

export interface ConnectorRecord {
  id: string;
  displayName: string;
  description: string;
  owner: string;
  status: ConnectorStatus;
  trustTier: 'first-party' | 'reviewed-mcp' | 'evaluation';
  createdAt: number;
  updatedAt: number;
}

export interface ConnectorVersionRecord {
  connectorId: string;
  version: string;
  status: ConnectorVersionStatus;
  manifest: ConnectorManifest;
  manifestHash: string;
  backendKind: BackendKind;
  publishedAt: number | null;
  createdAt: number;
}

export interface ConnectionRecord {
  id: string;
  agentId: string;
  tenantId: string;
  connectorId: string;
  connectorVersion: string;
  /** Opaque reference only — never a token/secret. */
  vaultCredentialRef: string | null;
  status: 'pending' | 'active' | 'revoked';
  approvedScopes: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ResourceScope {
  /** e.g. mailbox/account id the grant is bound to. */
  accountRef?: string;
  labels?: string[];
  recipientDomainsAllow?: string[];
  maxResults?: number;
  maxAttachmentBytes?: number;
}

export interface CapabilityGrantRecord {
  id: string;
  agentId: string;
  tenantId: string;
  connectionId: string;
  capabilityId: string;
  connectorVersion: string;
  effect: GrantEffect;
  resourceScope: ResourceScope;
  grantVersion: number;
  issuedBy: string;
  reason: string;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

export interface ApprovalPolicyRecord {
  id: string;
  capabilityId: string;
  /** '*' matches any agent/tenant. */
  agentId: string;
  tenantId: string;
  mode: ApprovalMode;
  conditions: {
    externalRecipient?: boolean;
    hasAttachment?: boolean;
  };
  policyVersion: number;
  createdAt: number;
}

export type ApprovalDecision = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRequestRecord {
  id: string;
  invocationRequestId: string;
  agentId: string;
  capabilityId: string;
  /** SHA-256 of the sanitized, canonicalized argument object. */
  argsHash: string;
  decision: ApprovalDecision;
  approver: string | null;
  decidedAt: number | null;
  expiresAt: number;
  createdAt: number;
}

export interface ConnectorInvocation {
  requestId: string;
  idempotencyKey?: string;
  agentId: string;
  tenantId: string;
  connectorId: string;
  connectorVersion?: string;
  capabilityId: string;
  connectionId: string;
  args: unknown;
  /** Set only after an approval_required round-trip; binds this call to that decision. */
  approvalRequestId?: string;
  traceId?: string;
}

export type ConnectorResultStatus = 'ok' | 'approval_required' | 'denied' | 'retryable_error' | 'provider_error';

export type DenyCode =
  | 'connector_disabled'
  | 'version_not_published'
  | 'unknown_capability'
  | 'capability_hard_denied'
  | 'no_grant'
  | 'grant_expired'
  | 'grant_revoked'
  | 'grant_denied'
  | 'resource_scope_violation'
  | 'connection_not_active'
  | 'feature_disabled'
  | 'backend_not_allowlisted'
  | 'invalid_args'
  | 'approval_denied'
  | 'approval_expired';

export interface ConnectorResult<T = unknown> {
  status: ConnectorResultStatus;
  requestId: string;
  data?: T;
  denyCode?: DenyCode;
  approvalRequestId?: string;
  errorMessage?: string;
}

export interface ConnectorAuditEvent {
  seq: number;
  requestId: string;
  actorAgentId: string;
  action: string;
  connectorId: string;
  connectorVersion: string;
  capabilityId: string | null;
  decision: ConnectorResultStatus;
  denyCode: DenyCode | null;
  /** SHA-256 of sanitized args; never the raw args. */
  argsHash: string | null;
  timestamp: number;
  /** SHA-256 chained over (prevHash + this event's canonical fields). */
  integrityHash: string;
  prevIntegrityHash: string | null;
}
