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
import { FakeVaultCredentialBroker } from '../../../src/connectors/credentials/credential-broker.js';
import { bootstrapGmailConnector } from '../../../src/connectors/providers/gmail/bootstrap.js';
import { GMAIL_CONNECTOR_ID, GMAIL_MANIFEST_VERSION } from '../../../src/connectors/providers/gmail/gmail-manifest.js';
import { DEFAULT_CONNECTOR_FEATURE_FLAGS, type ConnectorFeatureFlags } from '../../../src/connectors/config/feature-flags.js';
import type { ConnectionRecord, ConnectorInvocation } from '../../../src/connectors/types.js';

const AGENT_ID = 'agent-a';
const TENANT_ID = 'tenant-a';

async function setup(flagOverrides: Partial<ConnectorFeatureFlags> = {}) {
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
    backends: { oauth_api: oauthBackend },
    featureFlags,
    connectorFlagGate: { [GMAIL_CONNECTOR_ID]: 'gmailConnectorEnabled' },
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
    expect(result.errorMessage).toMatch(/no credential is available/);
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
      invocation({ requestId, capabilityId: 'gmail.drafts.send', connection, args: { draftId: 'd1' } }),
    );
    expect(first.status).toBe('approval_required');
    expect(first.approvalRequestId).toBeTruthy();

    await approvalRequests.decide(first.approvalRequestId!, 'approved', 'operator-1');

    const second = await router.route(
      invocation({
        requestId,
        capabilityId: 'gmail.drafts.send',
        connection,
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
      invocation({ requestId, capabilityId: 'gmail.drafts.send', connection, args: { draftId: 'd1' } }),
    );
    await approvalRequests.decide(first.approvalRequestId!, 'denied', 'operator-1');

    const second = await router.route(
      invocation({
        requestId,
        capabilityId: 'gmail.drafts.send',
        connection,
        args: { draftId: 'd1' },
        approvalRequestId: first.approvalRequestId,
      }),
    );
    expect(second.status).toBe('denied');
    expect(second.denyCode).toBe('approval_denied');
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
