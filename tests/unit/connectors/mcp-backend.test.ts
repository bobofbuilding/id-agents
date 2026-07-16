// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { McpBackend } from '../../../src/connectors/backends/mcp-backend.js';
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

const reviewedServer = {
  serverName: 'reviewed-gmail-mcp',
  spec: { name: 'reviewed-gmail-mcp', transport: 'stdio' as const, command: '/bin/reviewed-mcp-server' },
  manifestDigest: 'sha256:deadbeef',
  toolMapping: { 'gmail.messages.search': 'gmail_search_messages' },
};

describe('McpBackend', () => {
  it('fails closed when the MCP backend feature flag is disabled, even for a reviewed server', async () => {
    const backend = new McpBackend({ reviewedServers: [reviewedServer], enabled: false });
    const result = await backend.invoke({ capability: searchCapability, connection, args: {}, requestId: 'r1' });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/feature-flagged off/);
  });

  it('rejects a binding for a server that is not on the reviewed allowlist', async () => {
    const backend = new McpBackend({ reviewedServers: [reviewedServer], enabled: true });
    await expect(
      backend.validateBinding({ name: 'x', kind: 'mcp', allowlistedOrigin: 'unreviewed-server' }),
    ).rejects.toThrow(/not a reviewed\/allowlisted MCP server/);
  });

  it('accepts a binding for a reviewed, digest-pinned server', async () => {
    const backend = new McpBackend({ reviewedServers: [reviewedServer], enabled: true });
    await expect(
      backend.validateBinding({ name: 'x', kind: 'mcp', allowlistedOrigin: 'reviewed-gmail-mcp' }),
    ).resolves.toBeUndefined();
  });

  it('denies a capability with no reviewed tool mapping instead of guessing a tool name', async () => {
    const backend = new McpBackend({ reviewedServers: [reviewedServer], enabled: true });
    const unmapped = { ...searchCapability, id: 'gmail.threads.get' };
    const result = await backend.invoke({ capability: unmapped, connection, args: {}, requestId: 'r1' });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/no reviewed tool mapping/);
  });

  it('never completes a live dispatch in this slice, even for a mapped capability', async () => {
    const backend = new McpBackend({ reviewedServers: [reviewedServer], enabled: true });
    const result = await backend.invoke({ capability: searchCapability, connection, args: {}, requestId: 'r1' });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/not implemented in this slice/);
  });
});
