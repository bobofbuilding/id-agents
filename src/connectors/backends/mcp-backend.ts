// SPDX-License-Identifier: MIT
/**
 * Reviewed-MCP backend. Builds on the existing per-agent MCP wiring in
 * src/harness/mcp.ts (McpServerSpec -> toMcpServerRecord, injected via
 * ID_MCP_SERVERS at spawn) rather than inventing a second MCP transport.
 *
 * The connector layer adds what that per-agent mechanism does not have:
 * a pinned server allowlist, a canonical tool-name mapping, and a
 * feature-flag gate evaluated before any server is attached or any
 * `tools/call` is issued. Dynamic server discovery and agent-chosen
 * `tools/call` names are structurally unreachable through this adapter —
 * `invoke` only accepts a capability id that the caller already resolved
 * from the manifest, and maps it through a fixed, reviewed table.
 */

import type { McpServerSpec } from '../../harness/types.js';
import type { BackendBinding, BackendInvocation, BackendResult, ConnectorBackend, HealthResult } from './connector-backend.js';

export interface ReviewedMcpServer {
  /** Must match BackendBinding.allowlistedOrigin exactly. */
  serverName: string;
  spec: McpServerSpec;
  /** SHA-256 or equivalent digest of the reviewed server's tool manifest. Required before use. */
  manifestDigest: string;
  /** capabilityId -> the exact MCP tool name this server exposes for it. No wildcard entries. */
  toolMapping: Record<string, string>;
}

export interface McpBackendOptions {
  /** Only servers present here can ever be bound; anything else fails closed. */
  reviewedServers: ReviewedMcpServer[];
  enabled: boolean;
}

export class McpBackend implements ConnectorBackend {
  readonly kind = 'mcp' as const;
  private readonly byName: Map<string, ReviewedMcpServer>;
  private readonly enabled: boolean;

  constructor(options: McpBackendOptions) {
    this.byName = new Map(options.reviewedServers.map((s) => [s.serverName, s]));
    this.enabled = options.enabled;
  }

  async validateBinding(binding: BackendBinding): Promise<void> {
    if (!this.enabled) throw new Error('McpBackend: MCP backend transport is feature-flagged off');
    const server = this.byName.get(binding.allowlistedOrigin);
    if (!server) {
      throw new Error(`McpBackend: "${binding.allowlistedOrigin}" is not a reviewed/allowlisted MCP server`);
    }
    if (!server.manifestDigest) {
      throw new Error(`McpBackend: reviewed server "${server.serverName}" is missing a pinned manifest digest`);
    }
  }

  async health(binding: BackendBinding): Promise<HealthResult> {
    try {
      await this.validateBinding(binding);
      return { healthy: true };
    } catch (err) {
      return { healthy: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async invoke(ctx: BackendInvocation): Promise<BackendResult> {
    if (!this.enabled) {
      return { ok: false, errorKind: 'provider', errorMessage: 'MCP backend transport is feature-flagged off' };
    }
    // The binding is resolved server-side by the router from the manifest,
    // never from agent input; connection.connectorVersion + capability.id
    // are the only inputs used to pick a server here.
    const server = [...this.byName.values()].find((s) => ctx.capability.id in s.toolMapping);
    if (!server) {
      return {
        ok: false,
        errorKind: 'provider',
        errorMessage: `McpBackend: capability "${ctx.capability.id}" has no reviewed tool mapping`,
      };
    }
    const toolName = server.toolMapping[ctx.capability.id];

    // Live `tools/call` dispatch against server.spec (stdio/http/sse, via the
    // shared harness MCP transport) is later, operator-approved wiring —
    // see Slice 7 in docs/connectors/gmail-first-connector-architecture.md.
    // Structurally, this adapter can never call an unmapped/unreviewed tool
    // because toolName only ever comes from the fixed toolMapping above.
    return {
      ok: false,
      errorKind: 'provider',
      errorMessage: `McpBackend: live dispatch to tool "${toolName}" on server "${server.serverName}" is not implemented in this slice`,
    };
  }
}
