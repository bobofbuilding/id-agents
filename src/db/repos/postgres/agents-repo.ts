// SPDX-License-Identifier: MIT

import type { AgentRedeployFields, AgentsRepository } from '../../db-service.js';
import type { AgentRow } from '../../types.js';
import type { DbAdapter } from '../../db-adapter.js';
import { parseAgentRef } from '../../../core/agent-identifier.js';

export class PgAgentsRepo implements AgentsRepository {
  constructor(private readonly db: DbAdapter) {}

  // ---------------------------------------------------------------------------
  // Single-row lookups
  // ---------------------------------------------------------------------------

  async getById(agentId: string): Promise<AgentRow | null> {
    const r = await this.db.query<AgentRow>(
      `SELECT * FROM agents WHERE id = $1 AND deleted_at IS NULL`,
      [agentId],
    );
    return r.rows[0] || null;
  }

  async getByName(teamId: string, name: string): Promise<AgentRow | null> {
    // Exact name match (also checks metadata->>'alias')
    const r = await this.db.query<AgentRow>(
      `SELECT * FROM agents WHERE team_id = $1 AND (name = $2 OR metadata->>'alias' = $2) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [teamId, name],
    );
    if (r.rows[0]) return r.rows[0];

    // Flexible resolution via parseAgentRef (handles displayId like "agent.20")
    try {
      const matches = await this.resolve(teamId, name);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        // Return the most recent if ambiguous
        return matches.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        )[0];
      }
    } catch {
      // parseAgentRef may throw on invalid format — fall through
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Multi-row resolution
  // ---------------------------------------------------------------------------

  async resolve(teamId: string, ref: string, tokenId?: string): Promise<AgentRow[]> {
    try {
      const parsed = parseAgentRef(ref);

      let query: string;
      let params: unknown[];

      if (tokenId) {
        // Caller supplied an explicit tokenId override
        if (parsed.alias) {
          query = `SELECT * FROM agents WHERE team_id = $1 AND token_id = $2 AND (LOWER(name) = $3 OR LOWER(metadata->>'alias') = $3) AND deleted_at IS NULL`;
          params = [teamId, tokenId, parsed.alias];
        } else {
          query = `SELECT * FROM agents WHERE team_id = $1 AND token_id = $2 AND deleted_at IS NULL`;
          params = [teamId, tokenId];
        }
      } else if (parsed.isFullySpecified && parsed.domain) {
        // ENS domain — exact match
        query = `SELECT * FROM agents WHERE team_id = $1 AND (LOWER(name) = $2 OR LOWER(domain) = $2 OR metadata->>'idchain_domain' = $2) AND deleted_at IS NULL`;
        params = [teamId, parsed.domain];
      } else if (parsed.tokenId && parsed.alias) {
        // alias + tokenId — must match both
        query = `SELECT * FROM agents WHERE team_id = $1 AND token_id = $2 AND (LOWER(name) = $3 OR LOWER(metadata->>'alias') = $3) AND deleted_at IS NULL`;
        params = [teamId, parsed.tokenId, parsed.alias];
      } else if (parsed.tokenId) {
        // Just tokenId
        query = `SELECT * FROM agents WHERE team_id = $1 AND token_id = $2 AND deleted_at IS NULL`;
        params = [teamId, parsed.tokenId];
      } else if (parsed.alias) {
        // Just alias — could be ambiguous
        query = `SELECT * FROM agents WHERE team_id = $1 AND (LOWER(name) = $2 OR LOWER(metadata->>'alias') = $2) AND deleted_at IS NULL ORDER BY created_at DESC`;
        params = [teamId, parsed.alias];
      } else {
        return [];
      }

      const r = await this.db.query<AgentRow>(query, params);
      return r.rows;
    } catch {
      return [];
    }
  }

  async resolveAcrossTeams(ref: string): Promise<AgentRow[]> {
    try {
      const parsed = parseAgentRef(ref);

      let query: string;
      let params: unknown[];

      if (parsed.isFullySpecified && parsed.domain) {
        query = `SELECT * FROM agents WHERE (LOWER(name) = $1 OR LOWER(domain) = $1 OR metadata->>'idchain_domain' = $1) AND deleted_at IS NULL`;
        params = [parsed.domain];
      } else if (parsed.alias) {
        query = `SELECT * FROM agents WHERE (LOWER(name) = $1 OR LOWER(metadata->>'alias') = $1) AND deleted_at IS NULL ORDER BY created_at DESC`;
        params = [parsed.alias];
      } else {
        return [];
      }

      const r = await this.db.query<AgentRow>(query, params);
      return r.rows;
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Routing lookup (single agent for message delivery)
  // ---------------------------------------------------------------------------

  async getForRouting(teamId: string, ref: string, tokenId?: string): Promise<AgentRow | null> {
    // Parse displayId format "alias.tokenId"
    let baseName = ref;
    let parsedTokenId = tokenId || null;

    if (!parsedTokenId) {
      const dotIndex = ref.lastIndexOf('.');
      if (dotIndex !== -1) {
        const afterDot = ref.slice(dotIndex + 1);
        if (/^\d+$/.test(afterDot)) {
          baseName = ref.slice(0, dotIndex);
          parsedTokenId = afterDot;
        }
      }
    }

    const r = parsedTokenId
      ? await this.db.query<AgentRow>(
          `SELECT id, name, type, endpoint, metadata, token_id FROM agents
           WHERE team_id = $1 AND (name = $2 OR metadata->>'alias' = $2) AND token_id = $3
           AND deleted_at IS NULL
           LIMIT 1`,
          [teamId, baseName, parsedTokenId],
        )
      : await this.db.query<AgentRow>(
          `SELECT id, name, type, endpoint, metadata, token_id FROM agents
           WHERE team_id = $1 AND (
             name = $2 OR id = $2 OR
             (metadata->>'alias' = $2)
           )
           AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          [teamId, ref],
        );

    return r.rows[0] || null;
  }

  // ---------------------------------------------------------------------------
  // List / count
  // ---------------------------------------------------------------------------

  async list(teamId: string, includeAutomator?: boolean): Promise<AgentRow[]> {
    const typeFilter = includeAutomator ? '' : `AND type != 'automator'`;
    const r = await this.db.query<AgentRow>(
      `SELECT *
       FROM agents
       WHERE team_id = $1
         AND deleted_at IS NULL
         AND (
           type NOT IN ('interactive', 'virtual')
           OR runtime = 'public-agent-remote'
         )
         ${typeFilter}
       ORDER BY created_at DESC`,
      [teamId],
    );
    return r.rows;
  }

  async listAllActive(teamId: string): Promise<AgentRow[]> {
    const result = await this.db.query<AgentRow>(
      `SELECT *
       FROM agents
       WHERE team_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [teamId],
    );
    return result.rows;
  }

  async nextPort(): Promise<number> {
    const r = await this.db.query<{ max_port: number | null }>(
      `SELECT MAX(port) as max_port FROM agents
       WHERE deleted_at IS NULL AND type = 'claude' AND port > 0`,
    );
    const maxPort = r.rows[0]?.max_port ?? null;
    return maxPort ? maxPort + 1 : 4101;
  }

  async count(teamId: string): Promise<string> {
    const r = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM agents
       WHERE team_id = $1
         AND deleted_at IS NULL
         AND (
           type NOT IN ('interactive', 'virtual')
           OR runtime = 'public-agent-remote'
         )`,
      [teamId],
    );
    return r.rows[0]?.count || '0';
  }

  // ---------------------------------------------------------------------------
  // Specialised finders
  // ---------------------------------------------------------------------------

  async findInteractive(teamId: string): Promise<AgentRow | null> {
    // Newest-first deterministic selection — when a team has multiple
    // interactive rows (e.g. CLI re-registered after a v3 sync), reply
    // routing must pick the most recently created one consistently.
    const r = await this.db.query<AgentRow>(
      `SELECT * FROM agents WHERE team_id = $1 AND type = 'interactive' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [teamId],
    );
    return r.rows[0] || null;
  }

  async findByRegistry(
    teamId: string,
    chainId: string,
    registryAddress: string,
    tokenId: string,
  ): Promise<AgentRow | null> {
    const r = await this.db.query<AgentRow>(
      `SELECT * FROM agents
       WHERE team_id = $1
         AND deleted_at IS NULL
         AND (registry->>'chainId') = $2
         AND LOWER(registry->>'registryAddress') = LOWER($3)
         AND (registry->>'tokenId') = $4
       LIMIT 1`,
      [teamId, chainId, registryAddress, tokenId],
    );
    return r.rows[0] || null;
  }

  async findHeartbeat(teamId: string): Promise<AgentRow[]> {
    const r = await this.db.query<AgentRow>(
      `SELECT * FROM agents WHERE team_id = $1 AND metadata->>'heartbeat' = 'true' AND deleted_at IS NULL`,
      [teamId],
    );
    return r.rows;
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  async create(
    agent: Partial<AgentRow> & {
      team_id: string;
      id: string;
      name: string;
      type: string;
      model: string;
      status: string;
      created_at: number;
    },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, working_directory, status, created_at, metadata, api_key, token_id, domain, runtime,
          customer_domain, public_endpoint_url, internal_endpoint_url, ssh_target)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        agent.team_id,
        agent.id,
        agent.name,
        agent.type,
        agent.model,
        agent.port ?? 0,
        agent.endpoint ?? null,
        agent.working_directory ?? null,
        agent.status,
        agent.created_at,
        agent.metadata ?? null,
        agent.api_key ?? null,
        agent.token_id ?? null,
        agent.domain ?? null,
        agent.runtime ?? 'claude-agent-sdk',
        agent.customer_domain ?? null,
        agent.public_endpoint_url ?? null,
        agent.internal_endpoint_url ?? null,
        agent.ssh_target ?? null,
      ],
    );
  }

  async upsert(
    agent: Partial<AgentRow> & { team_id: string; id: string; name: string },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, working_directory, status, created_at, metadata, token_id, domain,
          customer_domain, public_endpoint_url, internal_endpoint_url, ssh_target)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (id)
       DO UPDATE SET name                 = EXCLUDED.name,
                     type                 = EXCLUDED.type,
                     endpoint             = EXCLUDED.endpoint,
                     status               = EXCLUDED.status,
                     metadata             = EXCLUDED.metadata,
                     created_at           = EXCLUDED.created_at,
                     domain               = COALESCE(EXCLUDED.domain, agents.domain),
                     deleted_at           = NULL`,
      [
        agent.team_id,
        agent.id,
        agent.name,
        agent.type ?? 'virtual',
        agent.model ?? 'external',
        agent.port ?? 0,
        agent.endpoint ?? null,
        agent.working_directory ?? '',
        agent.status ?? 'running',
        agent.created_at ?? Date.now(),
        agent.metadata ?? null,
        agent.token_id ?? null,
        agent.domain ?? null,
        agent.customer_domain ?? null,
        agent.public_endpoint_url ?? null,
        agent.internal_endpoint_url ?? null,
        agent.ssh_target ?? null,
      ],
    );
  }

  async redeploy(agentId: string, fields: AgentRedeployFields): Promise<void> {
    const result = await this.db.query(
      `UPDATE agents
       SET name = $2,
           type = $3,
           model = $4,
           port = $5,
           endpoint = $6,
           working_directory = $7,
           status = $8,
           metadata = $9,
           runtime = $10,
           token_id = $11,
           domain = $12,
           deleted_at = NULL
       WHERE id = $1 AND deleted_at IS NULL`,
      [
        agentId,
        fields.name,
        fields.type,
        fields.model,
        fields.port,
        fields.endpoint,
        fields.working_directory,
        fields.status,
        fields.metadata,
        fields.runtime,
        fields.token_id,
        fields.domain,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Agent redeploy expected one row for ${agentId}, updated ${result.rowCount}`);
    }
  }

  async updateIdentity(
    agentId: string,
    fields: {
      name?: string;
      token_id?: string;
      domain?: string;
      endpoint?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE agents SET name = $2, token_id = $3, domain = $4, endpoint = $5, metadata = $6 WHERE id = $1`,
      [
        agentId,
        fields.name ?? null,
        fields.token_id ?? null,
        fields.domain ?? null,
        fields.endpoint ?? null,
        fields.metadata ?? null,
      ],
    );
  }

  async updateMetadata(
    agentId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(
      `UPDATE agents SET metadata = $2 WHERE id = $1`,
      [agentId, metadata],
    );
  }

  async transitionOwnedProcessExit(
    agentId: string,
    processGeneration: string,
    restartAfterManagerStart: boolean,
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE agents
          SET status = CASE
                WHEN $3 OR metadata->>'managerRestartRequested' = 'true'
                  THEN 'offline'
                ELSE 'stopped'
              END,
              metadata = CASE
                WHEN $3 OR metadata->>'managerRestartRequested' = 'true'
                  THEN (
                    COALESCE(metadata, '{}'::jsonb)
                    - 'pid'
                    - 'processOwner'
                    - 'processParentPid'
                    - 'processInspectedAt'
                    - 'processGeneration'
                    - 'processRuntime'
                    - 'processRuntimeLane'
                  ) || '{"managerRestartRequested":true}'::jsonb
                ELSE (
                  COALESCE(metadata, '{}'::jsonb)
                  - 'pid'
                  - 'processOwner'
                  - 'processParentPid'
                  - 'processInspectedAt'
                  - 'processGeneration'
                  - 'processRuntime'
                  - 'processRuntimeLane'
                  - 'managerRestartRequested'
                  - 'managerOwnedLaunchIntent'
                )
              END
        WHERE id = $1
          AND metadata->>'processGeneration' = $2`,
      [
        agentId,
        processGeneration,
        restartAfterManagerStart,
      ],
    );
    return result.rowCount === 1;
  }

  async updateOwnedProcessState(
    agentId: string,
    processGeneration: string,
    status: string,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    if (
      metadata !== undefined
      && metadata.processGeneration !== processGeneration
    ) {
      throw new Error('owned process metadata generation mismatch');
    }
    const result = metadata === undefined
      ? await this.db.query(
          `UPDATE agents
              SET status = $3
            WHERE id = $1
              AND metadata->>'processGeneration' = $2`,
          [agentId, processGeneration, status],
        )
      : await this.db.query(
          `UPDATE agents
              SET status = $3,
                  metadata = $4
            WHERE id = $1
              AND metadata->>'processGeneration' = $2`,
          [agentId, processGeneration, status, metadata],
        );
    return result.rowCount === 1;
  }

  async clearOwnedProcessMetadata(
    agentId: string,
    expectedPid?: number,
    expectedGeneration?: string,
  ): Promise<boolean> {
    const conditions = ['id = $1'];
    const params: unknown[] = [agentId];
    if (expectedPid !== undefined) {
      params.push(String(expectedPid));
      conditions.push(`metadata->>'pid' = $${params.length}`);
    }
    if (expectedGeneration !== undefined) {
      params.push(expectedGeneration);
      conditions.push(`metadata->>'processGeneration' = $${params.length}`);
    }
    const result = await this.db.query(
      `UPDATE agents
          SET metadata = (
            COALESCE(metadata, '{}'::jsonb)
            - 'pid'
            - 'processOwner'
            - 'processParentPid'
            - 'processInspectedAt'
            - 'processGeneration'
            - 'processRuntime'
            - 'processRuntimeLane'
          )
        WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return result.rowCount === 1;
  }

  async moveToTeam(agentId: string, teamId: string, status?: string): Promise<void> {
    if (status !== undefined) {
      await this.db.query(
        `UPDATE agents SET team_id = $2, status = $3 WHERE id = $1`,
        [agentId, teamId, status],
      );
      return;
    }
    await this.db.query(
      `UPDATE agents SET team_id = $2 WHERE id = $1`,
      [agentId, teamId],
    );
  }

  async updateStatus(
    agentId: string,
    status: string,
    extra?: {
      port?: number;
      endpoint?: string;
      metadata?: Record<string, unknown>;
      model?: string;
      runtime?: string;
    },
  ): Promise<void> {
    if (!extra || Object.keys(extra).length === 0) {
      await this.db.query(
        `UPDATE agents SET status = $2 WHERE id = $1`,
        [agentId, status],
      );
      return;
    }

    // Build a dynamic SET clause for the optional extra fields
    const setClauses: string[] = ['status = $2'];
    const params: unknown[] = [agentId, status];
    let idx = 3;

    if (extra.port !== undefined) {
      setClauses.push(`port = $${idx++}`);
      params.push(extra.port);
    }
    if (extra.endpoint !== undefined) {
      setClauses.push(`endpoint = $${idx++}`);
      params.push(extra.endpoint);
    }
    if (extra.metadata !== undefined) {
      setClauses.push(`metadata = $${idx++}`);
      params.push(extra.metadata);
    }
    if (extra.model !== undefined) {
      setClauses.push(`model = $${idx++}`);
      params.push(extra.model);
    }
    if (extra.runtime !== undefined) {
      setClauses.push(`runtime = $${idx++}`);
      params.push(extra.runtime);
    }

    await this.db.query(
      `UPDATE agents SET ${setClauses.join(', ')} WHERE id = $1`,
      params,
    );
  }

  // ---------------------------------------------------------------------------
  // Deletion
  // ---------------------------------------------------------------------------

  async softDelete(
    teamId: string,
    name: string,
    excludeId: string,
    timestamp: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE agents SET deleted_at = $3
       WHERE team_id = $1 AND name = $2 AND type IN ('virtual','interactive') AND id <> $4 AND deleted_at IS NULL`,
      [teamId, name, timestamp, excludeId],
    );
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM agents WHERE id = $1`,
      [agentId],
    );
  }

  async updateProbeResult(
    agentId: string,
    fields: {
      last_seen?: number | null;
      last_probed_at: number;
      last_error?: string | null;
      consecutive_failures: number;
    },
  ): Promise<void> {
    const setClauses: string[] = ['last_probed_at = $2', 'consecutive_failures = $3'];
    const params: unknown[] = [agentId, fields.last_probed_at, fields.consecutive_failures];
    let idx = 4;

    if ('last_seen' in fields) {
      setClauses.push(`last_seen = $${idx++}`);
      params.push(fields.last_seen ?? null);
    }
    if ('last_error' in fields) {
      setClauses.push(`last_error = $${idx++}`);
      params.push(fields.last_error ?? null);
    }

    await this.db.query(
      `UPDATE agents SET ${setClauses.join(', ')} WHERE id = $1`,
      params,
    );
  }
}
