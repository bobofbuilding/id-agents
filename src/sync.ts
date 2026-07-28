// SPDX-License-Identifier: MIT

import type { AgentSpec } from './config-parser.js';
import type { AgentRow } from './db/types.js';
import { resolveRuntime, getDefaultModelForRuntime } from './runtime/registry.js';
import type { HarnessType } from './harness/types.js';
import { resolveAgentEnvironment } from './agent-env.js';

export type SyncCategory = 'new' | 'removed' | 'changed' | 'unchanged';

export interface SyncItem {
  name: string;
  category: SyncCategory;
  changes?: string[];
}

export interface SyncPlan {
  added: SyncItem[];
  removed: SyncItem[];
  changed: SyncItem[];
  unchanged: SyncItem[];
  conflicts: Array<{ name: string; message: string }>;
}

export interface SyncResult {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
}

const DIFF_FIELDS = [
  'name',
  'identityKey',
  'yamlManaged',
  'type',
  'model',
  'runtime',
  'plugins',
  'agent',
  'skills',
  'mcpServers',
  'heartbeat',
  'allowedTools',
  'env',
  'description',
  'domain',
  'tokenId',
  'workingDirectory',
  'wallet',
  'openMode',
  'dangerouslySkipPermissions',
  'catalog',
] as const;

/**
 * Stable, sort-aware JSON serialization of the catalog seed for diff comparison.
 * Without sorting, two semantically-equal catalog blocks could compare unequal
 * just because YAML key order differed.
 */
function normalizeCatalog(catalog: unknown): string {
  if (!catalog || typeof catalog !== 'object') return '';
  const sortedKeys = Object.keys(catalog as Record<string, unknown>).sort();
  if (sortedKeys.length === 0) return '';
  const ordered: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const v = (catalog as Record<string, unknown>)[k];
    // Sort scalar arrays (e.g. expertise, notSuitableFor) so ['a','b'] and
    // ['b','a'] compare equal. Object/nested arrays are left as-is — the
    // catalog schema doesn't currently use them.
    if (Array.isArray(v) && v.every(item => typeof item === 'string')) {
      ordered[k] = [...v].sort();
    } else {
      ordered[k] = v;
    }
  }
  return JSON.stringify(ordered);
}

function normalizePlugins(plugins?: Array<{ name: string; path?: string }> | null): string {
  if (!plugins || plugins.length === 0) return '';
  return plugins
    .map(p => p.name)
    .sort()
    .join(',');
}

function normalizeSkills(skills?: string[] | null): string {
  if (!skills || skills.length === 0) return '';
  return [...skills].sort().join(',');
}

function normalizeMetadataSkills(skills: unknown): string {
  if (!skills) return '';
  if (Array.isArray(skills)) {
    return normalizeSkills(skills.filter((skill): skill is string => typeof skill === 'string'));
  }
  if (typeof skills === 'string') {
    return normalizeSkills(
      skills
        .split(',')
        .map(skill => skill.trim())
        .filter(Boolean),
    );
  }
  return '';
}

function normalizeAllowedTools(tools: unknown, declared: boolean): string {
  if (!declared) return 'omitted';
  if (!Array.isArray(tools)) return 'invalid';
  return `declared:${tools
    .filter((tool): tool is string => typeof tool === 'string')
    .map((tool) => tool.trim())
    .sort()
    .join(',')}`;
}

function normalizeEnvironment(env: unknown): string {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return '';
  const entries = Object.entries(env as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length > 0
    ? JSON.stringify(Object.fromEntries(entries))
    : '';
}

function normalizeMcpServers(servers?: unknown): string {
  if (!Array.isArray(servers) || servers.length === 0) return '';
  const normalized = servers
    .filter((server): server is Record<string, unknown> => !!server && typeof server === 'object')
    .map((server) => {
      const ordered: Record<string, unknown> = {};
      for (const key of ['name', 'transport', 'command', 'args', 'url', 'env', 'headers']) {
        const value = server[key];
        if (value !== undefined) ordered[key] = value;
      }
      return ordered;
    })
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return JSON.stringify(normalized);
}

function normalizeRuntime(runtime: string | undefined, defaultRuntime?: string): string {
  return resolveRuntime((runtime || defaultRuntime) as HarnessType);
}

function normalizeModel(model: string | undefined, runtime: string | undefined, defaultModel?: string): string {
  const resolved = resolveRuntime(runtime as HarnessType);
  return model || getDefaultModelForRuntime(resolved, defaultModel);
}

/**
 * Extracts comparable field values from a config AgentSpec.
 */
function configFields(spec: AgentSpec, defaultModel?: string): Record<string, string> {
  const runtime = normalizeRuntime(spec.runtime);
  return {
    name: spec.name,
    identityKey: spec.identityKey || '',
    yamlManaged: 'true',
    type: spec.type || 'claude',
    model: normalizeModel(spec.model, spec.runtime, defaultModel),
    runtime,
    plugins: normalizePlugins(spec.plugins),
    agent: spec.agent || '',
    skills: normalizeSkills(spec.skills),
    mcpServers: normalizeMcpServers(spec.mcpServers),
    heartbeat: spec.heartbeat ? (typeof spec.heartbeat === 'number' ? String(spec.heartbeat) : JSON.stringify({ interval: spec.heartbeat.interval, message: spec.heartbeat.message })) : '',
    allowedTools: normalizeAllowedTools(
      spec.allowedTools,
      Object.prototype.hasOwnProperty.call(spec, 'allowedTools'),
    ),
    env: normalizeEnvironment(resolveAgentEnvironment(spec)),
    description: spec.description || '',
    domain: spec.domain || '',
    tokenId: spec.tokenId || '',
    workingDirectory: spec.workingDirectory || '',
    wallet: spec.wallet === undefined ? '' : String(spec.wallet),
    openMode: String(spec.openMode === true),
    dangerouslySkipPermissions: spec.dangerouslySkipPermissions === undefined
      ? 'true'
      : String(spec.dangerouslySkipPermissions),
    catalog: normalizeCatalog(spec.catalog),
  };
}

/**
 * Extracts comparable field values from a running DB AgentRow.
 */
function runningFields(row: AgentRow): Record<string, string> {
  const meta = (row.metadata || {}) as Record<string, any>;
  const hasProvisionedWalletMetadata = Boolean(
    meta.ows_wallet || meta.ows_address || meta.ows_wallet_seed,
  );
  const wallet = meta.wallet === false && hasProvisionedWalletMetadata
    ? 'false:provisioned'
    : meta.wallet === true && !meta.ows_wallet
      ? 'true:missing'
      : meta.wallet === undefined
        ? ''
        : String(meta.wallet);
  return {
    name: typeof meta.name === 'string' && meta.name
      ? meta.name
      : typeof meta.alias === 'string' && meta.alias
        ? meta.alias
        : row.name,
    identityKey: typeof meta.identityKey === 'string' ? meta.identityKey : '',
    yamlManaged: String(meta.yamlManaged === true),
    type: row.type || '',
    model: row.model || '',
    runtime: normalizeRuntime(row.runtime),
    plugins: normalizePlugins(meta.plugins),
    agent: meta.agent || '',
    skills: normalizeMetadataSkills(meta.skills),
    mcpServers: normalizeMcpServers(meta.mcpServers),
    heartbeat: meta.heartbeat === true ? 'enabled' : '',
    allowedTools: normalizeAllowedTools(
      meta.allowed_tools,
      Object.prototype.hasOwnProperty.call(meta, 'allowed_tools'),
    ),
    env: normalizeEnvironment(meta.env),
    description: meta.description || '',
    domain: row.domain || '',
    tokenId: row.token_id || '',
    workingDirectory: row.working_directory || '',
    wallet,
    openMode: String(meta.openMode === true),
    dangerouslySkipPermissions: meta.dangerouslySkipPermissions === undefined
      ? 'true'
      : String(meta.dangerouslySkipPermissions),
    catalog: normalizeCatalog(meta.catalog),
  };
}

/**
 * Compute the diff between a config spec and a running agent.
 * Returns the list of field names that differ, or empty if unchanged.
 */
export function diffAgent(spec: AgentSpec, row: AgentRow, defaultModel?: string): string[] {
  const cfg = configFields(spec, defaultModel);
  const run = runningFields(row);
  const changes: string[] = [];

  for (const field of DIFF_FIELDS) {
    // heartbeat: config has structured data, DB just stores a boolean flag.
    // Compare presence only: if config has heartbeat and DB doesn't (or vice versa).
    if (field === 'heartbeat') {
      const cfgHas = !!spec.heartbeat;
      const runHas = run.heartbeat === 'enabled';
      if (cfgHas !== runHas) changes.push(field);
      continue;
    }

    // workingDirectory: only compare when the config explicitly sets one.
    // Auto-generated directories (based on agent ID) always differ.
    if (field === 'workingDirectory') {
      if (cfg[field] && cfg[field] !== run[field]) {
        changes.push(field);
      }
      continue;
    }

    // Durable identity, wallet ownership, and a live catalog survive omission
    // from a later YAML file. Only an explicit value is authorization to
    // replace or seed them.
    if (
      (field === 'domain'
        || field === 'tokenId'
        || field === 'identityKey'
        || field === 'wallet'
        || field === 'catalog')
      && spec[field] === undefined
    ) {
      continue;
    }

    if (cfg[field] !== run[field]) {
      changes.push(field);
    }
  }

  return changes;
}

export interface AgentSpecIdentityResolution {
  row: AgentRow | null;
  error?: string;
}

function normalizedIdentityName(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

function rowMatchesConfiguredName(row: AgentRow, desiredNames: Set<string>): boolean {
  const metadata = (row.metadata || {}) as Record<string, unknown>;
  return [
    row.name,
    row.domain,
    metadata.alias,
    metadata.idchain_domain,
  ].some((value) => {
    const normalized = normalizedIdentityName(value);
    return normalized !== null && desiredNames.has(normalized);
  });
}

/**
 * Resolve a declarative agent identity without guessing.
 *
 * An explicit identityKey is authoritative. A same-name row without a key may
 * adopt it during the first upgrade, but a key/name disagreement, duplicate
 * persisted key, or ambiguous legacy name fails closed.
 */
export function resolveAgentSpecIdentity(
  spec: AgentSpec,
  runningAgents: AgentRow[],
): AgentSpecIdentityResolution {
  const desiredNames = new Set(
    [spec.name, spec.domain]
      .map(normalizedIdentityName)
      .filter((value): value is string => value !== null),
  );
  const nameMatches = runningAgents.filter((row) => rowMatchesConfiguredName(row, desiredNames));
  const identityKey = spec.identityKey;

  if (!identityKey) {
    if (nameMatches.length > 1) {
      return {
        row: null,
        error: `Agent "${spec.name}" matches multiple existing rows (${nameMatches.map((row) => row.id).join(', ')}); add a unique identityKey before redeploying`,
      };
    }
    return { row: nameMatches[0] || null };
  }

  const keyMatches = runningAgents.filter((row) => (
    (row.metadata as Record<string, unknown> | null)?.identityKey === identityKey
  ));
  if (keyMatches.length > 1) {
    return {
      row: null,
      error: `identityKey "${identityKey}" is already attached to multiple existing rows (${keyMatches.map((row) => row.id).join(', ')})`,
    };
  }

  const keyedRow = keyMatches[0];
  if (keyedRow) {
    const nameCollision = nameMatches.find((row) => row.id !== keyedRow.id);
    if (nameCollision) {
      return {
        row: null,
        error: `identityKey "${identityKey}" resolves to ${keyedRow.id}, but name "${spec.domain || spec.name}" belongs to ${nameCollision.id}`,
      };
    }
    return { row: keyedRow };
  }

  if (nameMatches.length > 1) {
    return {
      row: null,
      error: `Agent "${spec.name}" matches multiple existing rows (${nameMatches.map((row) => row.id).join(', ')}); identityKey "${identityKey}" cannot be adopted safely`,
    };
  }

  const legacyRow = nameMatches[0];
  if (!legacyRow) return { row: null };
  const existingKey = (legacyRow.metadata as Record<string, unknown> | null)?.identityKey;
  if (typeof existingKey === 'string' && existingKey !== identityKey) {
    return {
      row: null,
      error: `Agent "${spec.name}" matches ${legacyRow.id}, which already owns identityKey "${existingKey}" instead of "${identityKey}"`,
    };
  }
  return { row: legacyRow };
}

/**
 * Given a list of config agent specs and a list of running DB rows,
 * produce a SyncPlan categorizing each agent.
 *
 * Agents are matched by name (config name or domain, matching DB row name).
 */
export function computeSyncPlan(
  configAgents: AgentSpec[],
  runningAgents: AgentRow[],
  defaultModel?: string,
): SyncPlan {
  const plan: SyncPlan = {
    added: [],
    removed: [],
    changed: [],
    unchanged: [],
    conflicts: [],
  };
  const matchedRowIds = new Set<string>();
  const claimedRows = new Map<string, string>();

  for (const spec of configAgents) {
    const name = spec.domain || spec.name;
    const resolution = resolveAgentSpecIdentity(spec, runningAgents);
    if (resolution.error) {
      plan.conflicts.push({ name, message: resolution.error });
      continue;
    }
    const row = resolution.row;
    if (!row) {
      plan.added.push({ name, category: 'new' });
      continue;
    }
    const priorClaim = claimedRows.get(row.id);
    if (priorClaim) {
      plan.conflicts.push({
        name,
        message: `Agent "${name}" and "${priorClaim}" both resolve to existing row ${row.id}`,
      });
      continue;
    }
    claimedRows.set(row.id, name);
    matchedRowIds.add(row.id);

    const changes = diffAgent(spec, row, defaultModel);
    if (changes.length > 0) {
      plan.changed.push({ name, category: 'changed', changes });
    } else {
      plan.unchanged.push({ name, category: 'unchanged' });
    }
  }

  // Agents in DB but not in config → removed
  for (const row of runningAgents) {
    if (!matchedRowIds.has(row.id)) {
      plan.removed.push({ name: row.name, category: 'removed' });
    }
  }

  return plan;
}

/**
 * Format a sync plan into a human-readable summary line.
 */
export function formatSyncSummary(plan: SyncPlan): string {
  return `Added ${plan.added.length}, updated ${plan.changed.length}, removed ${plan.removed.length}, unchanged ${plan.unchanged.length}`;
}

/**
 * Format a verbose sync plan with per-agent details.
 */
export function formatSyncVerbose(plan: SyncPlan): string {
  const lines: string[] = [];

  for (const item of plan.added) {
    lines.push(`  + ${item.name} (new)`);
  }
  for (const item of plan.changed) {
    lines.push(`  ~ ${item.name} (changed: ${item.changes?.join(', ')})`);
  }
  for (const item of plan.removed) {
    lines.push(`  - ${item.name} (removed)`);
  }
  for (const item of plan.unchanged) {
    lines.push(`  = ${item.name} (unchanged)`);
  }

  return lines.join('\n');
}
