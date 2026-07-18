// SPDX-License-Identifier: MIT
/**
 * Shared source for the agent profile (bio + handles) published in
 * `/.well-known/restap.json`.
 *
 * One source of truth: the manager's agent record (`metadata.bio` /
 * `metadata.handles`, written by config deploy/sync and by
 * `POST /agents/by-name/:name/profile`). Servers publish it two ways:
 *
 *  - locally-held identity metadata when the manager has pushed it to the
 *    server (`setIdentity` / `PATCH /identity`) — always freshest, no I/O;
 *  - otherwise a self-lookup of `GET {managerUrl}/agents` with a short
 *    in-memory TTL cache, so the catalog stays fresh after edits without a
 *    manager round-trip on every request.
 *
 * Used by claude-agent-server (also exported as AgentRestServer for
 * local-agent-server) and interactive-agent-server (also used by
 * human-agent-cli) so all published catalogs stay consistent.
 */

export interface PublishedAgentProfile {
  bio?: string;
  handles?: Record<string, string>;
}

/** Extract a publishable profile from agent metadata; null when unset. */
export function extractProfile(metadata: unknown): PublishedAgentProfile | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const m = metadata as Record<string, unknown>;
  const out: PublishedAgentProfile = {};
  if (typeof m.bio === 'string' && m.bio.length > 0) out.bio = m.bio;
  if (typeof m.handles === 'object' && m.handles !== null && !Array.isArray(m.handles)) {
    const handles: Record<string, string> = {};
    for (const [key, value] of Object.entries(m.handles as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) handles[key] = value;
    }
    if (Object.keys(handles).length > 0) out.handles = handles;
  }
  return out.bio !== undefined || out.handles !== undefined ? out : null;
}

export interface SelfProfileSourceOptions {
  /** The agent's own name (function form so a later rename is picked up). */
  agentName: string | (() => string | undefined);
  /** Manager base URL; defaults to env MANAGER_URL, then localhost:4100. */
  managerUrl?: string;
  /** Team for the X-Id-Team header; defaults to env ID_TEAM (omitted if unset). */
  team?: string;
  /** Cache TTL for manager lookups. Default 5000ms. */
  ttlMs?: number;
  /** Locally-held identity metadata — preferred whenever it yields a profile. */
  getLocal?: () => unknown;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Returns an async getter for this agent's published profile. Never throws:
 * on manager errors it serves the last known value (or null).
 */
export function createSelfProfileSource(
  opts: SelfProfileSourceOptions,
): () => Promise<PublishedAgentProfile | null> {
  const ttl = opts.ttlMs ?? 5000;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  let cached: PublishedAgentProfile | null = null;
  let cachedAt = Number.NEGATIVE_INFINITY;

  return async () => {
    // Pushed identity metadata is the freshest source — no I/O, no cache.
    const local = opts.getLocal ? extractProfile(opts.getLocal()) : null;
    if (local) return local;

    if (now() - cachedAt < ttl) return cached;

    const name = typeof opts.agentName === 'function' ? opts.agentName() : opts.agentName;
    const managerUrl = (
      opts.managerUrl ?? process.env.MANAGER_URL ?? 'http://localhost:4100'
    ).replace(/\/+$/, '');
    const team = opts.team ?? process.env.ID_TEAM;

    try {
      const res = await doFetch(`${managerUrl}/agents`, {
        headers: team ? { 'X-Id-Team': team } : {},
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = (await res.json()) as { agents?: Array<{ name?: string; metadata?: unknown }> };
        const rows = Array.isArray(body?.agents) ? body.agents : [];
        const self = name ? rows.find((a) => a?.name === name) : undefined;
        cached = self ? extractProfile(self.metadata) : null;
      }
      // Non-OK responses keep the last known value.
    } catch {
      // Network/timeout errors keep the last known value.
    }
    cachedAt = now();
    return cached;
  };
}
