// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { OAuthApiBackend } from '../../../src/connectors/backends/oauth-api-backend.js';
import { FakeVaultCredentialBroker } from '../../../src/connectors/credentials/credential-broker.js';
import { GMAIL_V1_MANIFEST } from '../../../src/connectors/providers/gmail/gmail-manifest.js';
import type { ConnectionRecord } from '../../../src/connectors/types.js';

const connection: ConnectionRecord = {
  id: 'conn-1',
  agentId: 'agent-a',
  tenantId: 'tenant-a',
  connectorId: 'gmail',
  connectorVersion: '1.0.0',
  vaultCredentialRef: null,
  status: 'active',
  approvedScopes: [],
  createdAt: 0,
  updatedAt: 0,
};

const searchCapability = GMAIL_V1_MANIFEST.capabilities.find((c) => c.id === 'gmail.messages.search')!;

describe('OAuthApiBackend', () => {
  it('never calls the injected fetch implementation with the default FakeVaultCredentialBroker', async () => {
    const fetchSpy = vi.fn();
    const backend = new OAuthApiBackend({
      credentialBroker: new FakeVaultCredentialBroker(),
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    const result = await backend.invoke({ capability: searchCapability, connection, args: { query: 'x' }, requestId: 'r1' });

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('not_connected');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a binding whose origin is not the reviewed Gmail origin', async () => {
    const backend = new OAuthApiBackend({ credentialBroker: new FakeVaultCredentialBroker() });
    await expect(
      backend.validateBinding({ name: 'evil', kind: 'oauth_api', allowlistedOrigin: 'https://evil.example.com' }),
    ).rejects.toThrow(/not the reviewed Gmail origin/);
  });

  it('accepts the reviewed Gmail origin', async () => {
    const backend = new OAuthApiBackend({ credentialBroker: new FakeVaultCredentialBroker() });
    await expect(
      backend.validateBinding({ name: 'google-gmail-v1', kind: 'oauth_api', allowlistedOrigin: 'https://gmail.googleapis.com' }),
    ).resolves.toBeUndefined();
  });

  it('health() reflects validateBinding() without throwing', async () => {
    const backend = new OAuthApiBackend({ credentialBroker: new FakeVaultCredentialBroker() });
    const bad = await backend.health({ name: 'evil', kind: 'oauth_api', allowlistedOrigin: 'https://evil.example.com' });
    expect(bad.healthy).toBe(false);
    const good = await backend.health({ name: 'google-gmail-v1', kind: 'oauth_api', allowlistedOrigin: 'https://gmail.googleapis.com' });
    expect(good.healthy).toBe(true);
  });
});
