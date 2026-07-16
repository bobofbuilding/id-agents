// SPDX-License-Identifier: MIT

import { describe, expect, it, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';
import { migrateConnectorsSqlite } from '../../../src/connectors/catalog/migrations.js';
import { ConnectorAuditLog, hashSanitizedArgs } from '../../../src/connectors/audit/audit-log.js';

async function freshDb(): Promise<SqliteAdapter> {
  const adapter = new SqliteAdapter(':memory:');
  await migrateConnectorsSqlite(adapter);
  return adapter;
}

describe('ConnectorAuditLog', () => {
  let adapter: SqliteAdapter;
  let log: ConnectorAuditLog;

  beforeEach(async () => {
    adapter = await freshDb();
    log = new ConnectorAuditLog(adapter);
  });

  it('chains each event to the previous event\'s integrity hash', async () => {
    const e1 = await log.append({
      requestId: 'req-1',
      actorAgentId: 'agent-a',
      action: 'connector.invoke',
      connectorId: 'gmail',
      connectorVersion: '1.0.0',
      capabilityId: 'gmail.messages.search',
      decision: 'ok',
      denyCode: null,
      argsHash: hashSanitizedArgs({ query: 'is:unread' }),
      timestamp: 1,
    });
    const e2 = await log.append({
      requestId: 'req-2',
      actorAgentId: 'agent-a',
      action: 'connector.invoke',
      connectorId: 'gmail',
      connectorVersion: '1.0.0',
      capabilityId: 'gmail.messages.get',
      decision: 'denied',
      denyCode: 'no_grant',
      argsHash: hashSanitizedArgs({ messageId: 'm1' }),
      timestamp: 2,
    });

    expect(e1.prevIntegrityHash).toBeNull();
    expect(e2.prevIntegrityHash).toBe(e1.integrityHash);
    expect(e2.integrityHash).not.toEqual(e1.integrityHash);
  });

  it('verifyChain passes on an untampered log', async () => {
    for (let i = 0; i < 5; i++) {
      await log.append({
        requestId: `req-${i}`,
        actorAgentId: 'agent-a',
        action: 'connector.invoke',
        connectorId: 'gmail',
        connectorVersion: '1.0.0',
        capabilityId: 'gmail.messages.search',
        decision: 'ok',
        denyCode: null,
        argsHash: null,
        timestamp: i,
      });
    }
    const result = await log.verifyChain();
    expect(result.ok).toBe(true);
  });

  it('verifyChain detects a tampered row', async () => {
    await log.append({
      requestId: 'req-1',
      actorAgentId: 'agent-a',
      action: 'connector.invoke',
      connectorId: 'gmail',
      connectorVersion: '1.0.0',
      capabilityId: 'gmail.messages.search',
      decision: 'ok',
      denyCode: null,
      argsHash: null,
      timestamp: 1,
    });
    await log.append({
      requestId: 'req-2',
      actorAgentId: 'agent-a',
      action: 'connector.invoke',
      connectorId: 'gmail',
      connectorVersion: '1.0.0',
      capabilityId: 'gmail.messages.get',
      decision: 'ok',
      denyCode: null,
      argsHash: null,
      timestamp: 2,
    });

    // Tamper with the first row's decision after the fact.
    await adapter.query(`UPDATE connector_audit_events SET decision = 'denied' WHERE seq = 1`);

    const result = await log.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAtSeq).toBe(1);
  });

  it('never stores raw args — only a hash', async () => {
    await log.append({
      requestId: 'req-1',
      actorAgentId: 'agent-a',
      action: 'connector.invoke',
      connectorId: 'gmail',
      connectorVersion: '1.0.0',
      capabilityId: 'gmail.drafts.create',
      decision: 'ok',
      denyCode: null,
      argsHash: hashSanitizedArgs({ to: ['someone@example.com'], subject: 'secret subject' }),
      timestamp: 1,
    });
    const events = await log.listAll();
    const raw = JSON.stringify(events);
    expect(raw).not.toContain('someone@example.com');
    expect(raw).not.toContain('secret subject');
  });
});
