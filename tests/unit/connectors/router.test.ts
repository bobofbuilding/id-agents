// SPDX-License-Identifier: MIT

import crypto from 'crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';
import { migrateConnectorsSqlite } from '../../../src/connectors/catalog/migrations.js';
import { ConnectorRegistry } from '../../../src/connectors/catalog/connector-registry.js';
import { ConnectorConnectionsRepo } from '../../../src/connectors/connections/connections-repo.js';
import { ConnectorGrantsRepo } from '../../../src/connectors/grants/grants-repo.js';
import { ApprovalPolicyRepo } from '../../../src/connectors/policy/approval-policy-repo.js';
import { ApprovalRequestsRepo } from '../../../src/connectors/policy/approval-requests-repo.js';
import { ConnectorAuditLog } from '../../../src/connectors/audit/audit-log.js';
import { ConnectorRouter } from '../../../src/connectors/runtime/router.js';
import { OAuthApiBackend } from '../../../src/connectors/backends/oauth-api-backend.js';
import type { ConnectorBackend } from '../../../src/connectors/backends/connector-backend.js';
import { FakeVaultCredentialBroker } from '../../../src/connectors/credentials/credential-broker.js';
import { bootstrapGmailConnector } from '../../../src/connectors/providers/gmail/bootstrap.js';
import {
  GMAIL_CAPABILITY_FLAG_GATE,
  GMAIL_CONNECTOR_FLAG_GATE,
  GMAIL_CONNECTOR_ID,
  GMAIL_MANIFEST_VERSION,
} from '../../../src/connectors/providers/gmail/gmail-manifest.js';
import {
  CONNECTOR_CAPABILITY_FLAG_GATE,
  DEFAULT_CONNECTOR_FEATURE_FLAGS,
  type ConnectorFeatureFlags,
} from '../../../src/connectors/config/feature-flags.js';
import type { ConnectionRecord, ConnectorInvocation } from '../../../src/connectors/types.js';

const AGENT_ID = 'agent-a';
const TENANT_ID = 'tenant-a';

async function setup(flagOverrides: Partial<ConnectorFeatureFlags> = {}, backendOverride?: ConnectorBackend) {
  const db = new SqliteAdapter(':memory:');
  await migrateConnectorsSqlite(db);

  const registry = new ConnectorRegistry(db);
  await bootstrapGmailConnector(registry);

  const connections = new ConnectorConnectionsRepo(db);
  const grants = new ConnectorGrantsRepo(db);
  const approvalPolicies = new ApprovalPolicyRepo(db);
  const approvalRequests = new ApprovalRequestsRepo(db);
  const auditLog = new ConnectorAuditLog(db);
  const oauthBackend = new OAuthApiBackend({ credentialBroker: new FakeVaultCredentialBroker() });

  const featureFlags: ConnectorFeatureFlags = {
    ...DEFAULT_CONNECTOR_FEATURE_FLAGS,
    connectorsEnabled: true,
    gmailConnectorEnabled: true,
    gmailSendEnabled: true,
    ...flagOverrides,
  };

  const router = new ConnectorRouter({
    db,
    registry,
    connections,
    grants,
    approvalPolicies,
    approvalRequests,
    auditLog,
    backends: { oauth_api: backendOverride ?? oauthBackend },
    featureFlags,
    connectorFlagGate: GMAIL_CONNECTOR_FLAG_GATE,
    capabilityFlagGate: CONNECTOR_CAPABILITY_FLAG_GATE,
  });

  const connection = await connections.create({
    agentId: AGENT_ID,
    tenantId: TENANT_ID,
    connectorId: GMAIL_CONNECTOR_ID,
    connectorVersion: GMAIL_MANIFEST_VERSION,
    status: 'active',
  });

  return { db, registry, connections, grants, approvalPolicies, approvalRequests, auditLog, router, connection };
}

function invocation(
  overrides: Partial<ConnectorInvocation> & { capabilityId: string; connection: ConnectionRecord },
): ConnectorInvocation {
  const { connection, ...rest } = overrides;
  return {
    requestId: crypto.randomUUID(),
    agentId: AGENT_ID,
    tenantId: TENANT_ID,
    connectorId: GMAIL_CONNECTOR_ID,
    connectorVersion: GMAIL_MANIFEST_VERSION,
    connectionId: connection.id,
    capabilityId: overrides.capabilityId,
    args: {},
    ...rest,
  };
}

describe('ConnectorRouter', () => {
  it('denies everything when the master feature flag is off', async () => {
    const { router, connection } = await setup({ connectorsEnabled: false });
    const result = await router.route(invocation({ capabilityId: 'gmail.messages.search', connection, args: { query: 'x' } }));
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('feature_disabled');
  });

  it('denies when the per-connector flag is off even though the master flag is on', async () => {
    const { router, connection } = await setup({ gmailConnectorEnabled: false });
    const result = await router.route(invocation({ capabilityId: 'gmail.messages.search', connection, args: { query: 'x' } }));
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('feature_disabled');
  });

  it('denies an unknown capability id', async () => {
    const { router, connection } = await setup();
    const result = await router.route(invocation({ capabilityId: 'gmail.messages.nonexistent', connection, args: {} }));
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('unknown_capability');
  });

  it('hard-denies gmail.messages.send regardless of any grant', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.messages.send',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(invocation({ capabilityId: 'gmail.messages.send', connection, args: {} }));
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('capability_hard_denied');
  });

  it('denies gmail.drafts.send when gmailSendEnabled is false even with an allow grant', async () => {
    const { router, grants, connection } = await setup({ gmailSendEnabled: false });
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.send',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(invocation({ capabilityId: 'gmail.drafts.send', connection, args: { draftId: 'd1' } }));
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('feature_disabled');
  });

  it('does not gate read/draft capabilities on gmailSendEnabled', async () => {
    const { router, grants, connection } = await setup({ gmailSendEnabled: false });
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.messages.search',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(invocation({ capabilityId: 'gmail.messages.search', connection, args: { query: 'x' } }));
    expect(result.status).not.toBe('denied');
  });

  it('denies when there is no active connection', async () => {
    const { router, connections } = await setup();
    const inactive = await connections.create({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectorId: GMAIL_CONNECTOR_ID,
      connectorVersion: GMAIL_MANIFEST_VERSION,
      status: 'pending',
    });
    const result = await router.route(invocation({ capabilityId: 'gmail.messages.search', connection: inactive, args: { query: 'x' } }));
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('connection_not_active');
  });

  it('denies a read capability with an active connection but no grant', async () => {
    const { router, connection } = await setup();
    const result = await router.route(invocation({ capabilityId: 'gmail.messages.search', connection, args: { query: 'x' } }));
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('no_grant');
  });

  it('rejects malformed args before touching a grant or backend', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.messages.search',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(
      invocation({ capabilityId: 'gmail.messages.search', connection, args: { unknownField: 'x' } }),
    );
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('invalid_args');
  });

  it('rejects non-empty args for capabilities with an empty input schema', async () => {
    const { router, connection } = await setup();
    const result = await router.route(
      invocation({ capabilityId: 'gmail.labels.list', connection, args: { unexpected: 'x' } }),
    );
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('invalid_args');
  });

  it('rejects wrong primitive and enum args before grant or backend dispatch', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.messages.search',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const wrongType = await router.route(
      invocation({ capabilityId: 'gmail.messages.search', connection, args: { query: 'x', maxResults: '10' } }),
    );
    expect(wrongType.status).toBe('denied');
    expect(wrongType.denyCode).toBe('invalid_args');

    const badEnum = await router.route(
      invocation({ capabilityId: 'gmail.messages.get', connection, args: { messageId: 'm1', format: 'raw' } }),
    );
    expect(badEnum.status).toBe('denied');
    expect(badEnum.denyCode).toBe('invalid_args');
  });

  it('denies draft creation when requested recipients exceed the grant recipient-domain scope', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.create',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      resourceScope: { recipientDomainsAllow: ['example.com'] },
      issuedBy: 'operator-1',
      reason: 'test',
    });

    const result = await router.route(
      invocation({
        capabilityId: 'gmail.drafts.create',
        connection,
        args: { to: ['ok@example.com', 'blocked@outside.test'], subject: 's', body: 'b' },
      }),
    );
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('resource_scope_violation');
  });

  it('passes external-recipient context into conditional approval policies', async () => {
    const { router, grants, approvalPolicies, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.create',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      resourceScope: { recipientDomainsAllow: ['example.com'] },
      issuedBy: 'operator-1',
      reason: 'test',
    });
    await approvalPolicies.upsertPolicy({
      capabilityId: 'gmail.drafts.create',
      mode: 'confirm',
      conditions: { externalRecipient: true },
    });

    const result = await router.route(
      invocation({
        capabilityId: 'gmail.drafts.create',
        connection,
        idempotencyKey: 'draft-create-approval-context',
        args: { to: ['Reviewer <person@example.com>'], subject: 's', body: 'b' },
      }),
    );
    expect(result.status).toBe('approval_required');
    expect(result.approvalRequestId).toBeTruthy();
  });

  it('requires an idempotency key before side-effecting draft capabilities can reach approval or backend dispatch', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.create',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });

    const result = await router.route(
      invocation({
        capabilityId: 'gmail.drafts.create',
        connection,
        args: { to: ['person@example.com'], subject: 's', body: 'b' },
      }),
    );
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('idempotency_required');
  });

  it('enforces maxResults grant caps before backend dispatch', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.messages.search',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      resourceScope: { maxResults: 5 },
      issuedBy: 'operator-1',
      reason: 'test',
    });

    const result = await router.route(
      invocation({ capabilityId: 'gmail.messages.search', connection, args: { query: 'is:unread', maxResults: 6 } }),
    );
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('resource_scope_violation');
  });

  it('routes a granted read capability through to the backend and gets a safe not-connected result (no live network)', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.messages.search',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(
      invocation({ capabilityId: 'gmail.messages.search', connection, args: { query: 'is:unread' } }),
    );
    // auto-approval capability reaches the backend; FakeVaultCredentialBroker
    // guarantees no live Gmail API call is possible.
    expect(result.status).toBe('provider_error');
    expect(result.errorMessage).toBe('Connector backend request failed');
  });

  it('does not expose provider diagnostic text in caller results or audit events', async () => {
    const providerDiagnostic = 'privacy-probe-secret-4b07a3';
    const backend: ConnectorBackend = {
      async validateBinding() {},
      async health() {
        return { healthy: true };
      },
      async invoke() {
        return { ok: false, errorKind: 'provider', errorMessage: providerDiagnostic };
      },
    };
    const { router, grants, connection, auditLog } = await setup({}, backend);
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.messages.search',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });

    const result = await router.route(
      invocation({ capabilityId: 'gmail.messages.search', connection, args: { query: 'is:unread' } }),
    );

    expect(result.status).toBe('provider_error');
    expect(result.errorMessage).toBe('Connector backend request failed');
    expect(JSON.stringify(result)).not.toContain(providerDiagnostic);
    expect(JSON.stringify(await auditLog.listAll())).not.toContain(providerDiagnostic);
  });

  it('a deny grant on drafts.send wins even without reaching approval', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.send',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'deny',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(invocation({ capabilityId: 'gmail.drafts.send', connection, args: { draftId: 'd1' } }));
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('grant_denied');
  });

  it('requires approval for drafts.send, then proceeds to the backend once approved', async () => {
    const { router, grants, approvalRequests, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.send',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });

    const requestId = crypto.randomUUID();
    const first = await router.route(
      invocation({
        requestId,
        capabilityId: 'gmail.drafts.send',
        connection,
        idempotencyKey: 'draft-send-approved',
        args: { draftId: 'd1' },
      }),
    );
    expect(first.status).toBe('approval_required');
    expect(first.approvalRequestId).toBeTruthy();

    await approvalRequests.decide(first.approvalRequestId!, 'approved', 'operator-1');

    const second = await router.route(
      invocation({
        requestId,
        capabilityId: 'gmail.drafts.send',
        connection,
        idempotencyKey: 'draft-send-approved',
        args: { draftId: 'd1' },
        approvalRequestId: first.approvalRequestId,
      }),
    );
    // Approval passed; reaches the backend, which safely refuses to send
    // without a real credential — no live email is ever sent by this slice.
    expect(second.status).toBe('provider_error');
  });

  it('denies drafts.send when the approval request was denied', async () => {
    const { router, grants, approvalRequests, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.send',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });

    const requestId = crypto.randomUUID();
    const first = await router.route(
      invocation({
        requestId,
        capabilityId: 'gmail.drafts.send',
        connection,
        idempotencyKey: 'draft-send-denied',
        args: { draftId: 'd1' },
      }),
    );
    await approvalRequests.decide(first.approvalRequestId!, 'denied', 'operator-1');

    const second = await router.route(
      invocation({
        requestId,
        capabilityId: 'gmail.drafts.send',
        connection,
        idempotencyKey: 'draft-send-denied',
        args: { draftId: 'd1' },
        approvalRequestId: first.approvalRequestId,
      }),
    );
    expect(second.status).toBe('denied');
    expect(second.denyCode).toBe('approval_denied');
  });

  it('replays a scoped idempotency key with the same args hash without invoking the backend again', async () => {
    const { router, grants, auditLog, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.create',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });

    const args = { to: ['person@example.com'], subject: 's', body: 'b' };
    const first = await router.route(
      invocation({ capabilityId: 'gmail.drafts.create', connection, idempotencyKey: 'draft-create-replay', args }),
    );
    const second = await router.route(
      invocation({ capabilityId: 'gmail.drafts.create', connection, idempotencyKey: 'draft-create-replay', args }),
    );

    expect(first.status).toBe('provider_error');
    expect(second.status).toBe('provider_error');
    const events = await auditLog.listAll();
    expect(events.map((event) => event.action)).toEqual(['connector.invoke', 'connector.idempotent_replay']);
  });

  it('denies idempotency-key reuse with different args for the same scoped invocation lane', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.create',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });

    await router.route(
      invocation({
        capabilityId: 'gmail.drafts.create',
        connection,
        idempotencyKey: 'draft-create-conflict',
        args: { to: ['person@example.com'], subject: 's', body: 'one' },
      }),
    );
    const conflict = await router.route(
      invocation({
        capabilityId: 'gmail.drafts.create',
        connection,
        idempotencyKey: 'draft-create-conflict',
        args: { to: ['person@example.com'], subject: 's', body: 'two' },
      }),
    );

    expect(conflict.status).toBe('denied');
    expect(conflict.denyCode).toBe('idempotency_conflict');
  });

  it('denies gmail.drafts.send under a recipient-domain-scoped grant when the requested recipients are outside scope', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.send',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      resourceScope: { recipientDomainsAllow: ['example.com'] },
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(
      invocation({ capabilityId: 'gmail.drafts.send', connection, args: { draftId: 'd1', to: ['blocked@outside.test'] } }),
    );
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('resource_scope_violation');
  });

  it('fails closed on gmail.drafts.send under a recipient-domain-scoped grant when `to` is omitted', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.send',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      resourceScope: { recipientDomainsAllow: ['example.com'] },
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(invocation({ capabilityId: 'gmail.drafts.send', connection, args: { draftId: 'd1' } }));
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('resource_scope_violation');
  });

  it('allows gmail.drafts.send under a recipient-domain-scoped grant when the requested recipients are in scope', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.send',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      resourceScope: { recipientDomainsAllow: ['example.com'] },
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(
      invocation({
        capabilityId: 'gmail.drafts.send',
        connection,
        idempotencyKey: 'draft-send-in-scope',
        args: { draftId: 'd1', to: ['person@example.com'] },
      }),
    );
    // Manifest floor is "always" approval so this still round-trips through
    // approval, but it must not be denied for scope — no live send happens.
    expect(result.status).toBe('approval_required');
  });

  it('denies gmail.drafts.reply when requested recipients exceed the grant recipient-domain scope', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.reply',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      resourceScope: { recipientDomainsAllow: ['example.com'] },
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(
      invocation({
        capabilityId: 'gmail.drafts.reply',
        connection,
        args: { threadId: 't1', messageId: 'm1', to: ['blocked@outside.test'], body: 'b' },
      }),
    );
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('resource_scope_violation');
  });

  it('requires an idempotency key before gmail.drafts.reply can reach approval or backend dispatch', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.drafts.reply',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(
      invocation({
        capabilityId: 'gmail.drafts.reply',
        connection,
        args: { threadId: 't1', messageId: 'm1', to: ['person@example.com'], body: 'b' },
      }),
    );
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('idempotency_required');
  });

  it('denies gmail.attachments.download above the manifest hard cap regardless of any grant', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.attachments.download',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(
      invocation({
        capabilityId: 'gmail.attachments.download',
        connection,
        args: { messageId: 'm1', attachmentId: 'a1', maxBytes: 50_000_000 },
      }),
    );
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('attachment_cap_exceeded');
  });

  it('lets a grant narrow the attachment byte cap below the manifest hard cap', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.attachments.download',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      resourceScope: { maxAttachmentBytes: 1_000 },
      issuedBy: 'operator-1',
      reason: 'test',
    });

    const withinGrantScope = await router.route(
      invocation({
        capabilityId: 'gmail.attachments.download',
        connection,
        args: { messageId: 'm1', attachmentId: 'a1', maxBytes: 500 },
      }),
    );
    expect(withinGrantScope.status).toBe('provider_error');

    const overGrantScope = await router.route(
      invocation({
        capabilityId: 'gmail.attachments.download',
        connection,
        args: { messageId: 'm1', attachmentId: 'a1', maxBytes: 2_000 },
      }),
    );
    expect(overGrantScope.status).toBe('denied');
    expect(overGrantScope.denyCode).toBe('resource_scope_violation');
  });

  it('denies gmail.messages.get_full when gmailFullBodyReadEnabled is off even with an allow grant', async () => {
    const { router, grants, connection } = await setup({ gmailFullBodyReadEnabled: false });
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.messages.get_full',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(
      invocation({ capabilityId: 'gmail.messages.get_full', connection, args: { messageId: 'm1' } }),
    );
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('feature_disabled');
  });

  it('does not gate metadata/snippet gmail.messages.get on gmailFullBodyReadEnabled', async () => {
    const { router, grants, connection } = await setup({ gmailFullBodyReadEnabled: false });
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.messages.get',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(
      invocation({ capabilityId: 'gmail.messages.get', connection, args: { messageId: 'm1', format: 'snippet' } }),
    );
    expect(result.status).not.toBe('denied');
  });

  it('requires per-invocation confirmation for gmail.messages.get_full once its flag is on', async () => {
    const { router, grants, connection } = await setup({ gmailFullBodyReadEnabled: true });
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.messages.get_full',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(
      invocation({ capabilityId: 'gmail.messages.get_full', connection, args: { messageId: 'm1' } }),
    );
    expect(result.status).toBe('approval_required');
  });

  it('rejects format "full" on gmail.messages.get now that full body is its own capability', async () => {
    const { router, grants, connection } = await setup();
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.messages.get',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    const result = await router.route(
      invocation({ capabilityId: 'gmail.messages.get', connection, args: { messageId: 'm1', format: 'full' } }),
    );
    expect(result.status).toBe('denied');
    expect(result.denyCode).toBe('invalid_args');
  });

  it('writes an audit event for every terminal decision, in order', async () => {
    const { router, grants, auditLog, connection } = await setup();
    await router.route(invocation({ capabilityId: 'gmail.messages.search', connection, args: { query: 'x' } }));
    await grants.issueGrant({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      connectionId: connection.id,
      capabilityId: 'gmail.messages.search',
      connectorVersion: GMAIL_MANIFEST_VERSION,
      effect: 'allow',
      issuedBy: 'operator-1',
      reason: 'test',
    });
    await router.route(invocation({ capabilityId: 'gmail.messages.search', connection, args: { query: 'x' } }));

    const events = await auditLog.listAll();
    expect(events.length).toBe(2);
    expect(events[0].decision).toBe('denied');
    expect(events[0].denyCode).toBe('no_grant');
    expect(events[1].decision).toBe('provider_error');
    const chain = await auditLog.verifyChain();
    expect(chain.ok).toBe(true);
  });
});

describe('connector flag-gate assembly stays Gmail-only at runtime', () => {
  it('CONNECTOR_CAPABILITY_FLAG_GATE is assembled entirely from GMAIL_CAPABILITY_FLAG_GATE — no other provider is wired', () => {
    expect(CONNECTOR_CAPABILITY_FLAG_GATE).toEqual(GMAIL_CAPABILITY_FLAG_GATE);
    expect(CONNECTOR_CAPABILITY_FLAG_GATE).toEqual({
      'gmail.messages.get_full': 'gmailFullBodyReadEnabled',
      'gmail.drafts.send': 'gmailSendEnabled',
    });
  });

  it('every gate value defaults to false, so assembly alone cannot enable a capability', () => {
    for (const flag of Object.values(CONNECTOR_CAPABILITY_FLAG_GATE)) {
      expect(DEFAULT_CONNECTOR_FEATURE_FLAGS[flag]).toBe(false);
    }
    expect(DEFAULT_CONNECTOR_FEATURE_FLAGS[GMAIL_CONNECTOR_FLAG_GATE[GMAIL_CONNECTOR_ID]]).toBe(false);
  });
});
