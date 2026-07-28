// SPDX-License-Identifier: MIT

/**
 * Declarative per-agent environment handling.
 *
 * Agent-owned values are intentionally narrower than the Manager's runtime
 * credential lanes. A team config may provide application-specific variables,
 * but it must never replace the process, profile, identity, provider, plugin,
 * MCP, wallet, or XMTP envelope assembled by the Manager.
 */

export interface AgentEnvironmentSource {
  env?: Record<string, unknown>;
  resources?: {
    env?: Record<string, unknown>;
  };
}

export const AGENT_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ROUTING_TLS_AND_TRUST_ENV_KEYS = new Set([
  'ALL_PROXY',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NO_PROXY',
  'REQUESTS_CA_BUNDLE',
  'SSLKEYLOGFILE',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
]);

const RESERVED_AGENT_ENV_KEYS = new Set([
  'ANTIGRAVITY_CLI_PATH',
  'ANTHROPIC_API_KEY',
  'APPDATA',
  'BASH_ENV',
  'BUN_INSTALL',
  'COMSPEC',
  'COPILOT_CLI_PATH',
  'CURSOR_AGENT_PATH',
  'DATABASE_URL',
  'ELECTRON_RUN_AS_NODE',
  'ENV',
  'GROK_CLI_PATH',
  'HOME',
  'KIRO_CLI_PATH',
  'KIMI_CLI_PATH',
  'LANG',
  'LD_PRELOAD',
  'LOCALAPPDATA',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NVM_DIR',
  'NVM_HOME',
  'NVM_SYMLINK',
  'OPENAI_API_KEY',
  'PATH',
  'PATHEXT',
  'PNPM_HOME',
  'PRIVATE_KEY',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SHELL',
  'SQLITE_PATH',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'VOLTA_HOME',
  'WORKSPACE_DIR',
  'XDG_CONFIG_HOME',
  'ZDOTDIR',
]);

/**
 * Values that can reroute provider traffic, weaken TLS, inject a loader, or
 * select an executable/profile are never accepted from declarative YAML.
 * Comparisons are case-insensitive so Windows cannot turn casing into a
 * policy bypass.
 */
export function isRoutingTlsOrExecutableEnvironmentKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return ROUTING_TLS_AND_TRUST_ENV_KEYS.has(normalized)
    || /^(?:DYLD_|LD_|NODE_)/.test(normalized)
    || /_(?:API_BASE|BASE_URL|BIN|COMMAND|DIR|DIRECTORY|ENDPOINT|ENDPOINT_URL|EXECUTABLE|HOME|PATH|PROXY)$/.test(normalized);
}

export function isReservedAgentEnvironmentKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return RESERVED_AGENT_ENV_KEYS.has(normalized)
    || isRoutingTlsOrExecutableEnvironmentKey(normalized)
    || /^(?:ANTHROPIC_|ANTIGRAVITY_|CLAUDE_|CODEX_|COPILOT_|CURSOR_|GROK_|ID_|IDACC_|KIRO_|KIMI_|MANAGER_|MCP_|OLLAMA_|OPENAI_|OWS_|PLUGIN_|PROVIDER_API_|SKILLMESH_|XMTP_)/.test(normalized);
}

const REVIEWED_RUNTIME_LANE_CREDENTIALS: Readonly<
  Record<string, Readonly<Record<string, ReadonlySet<string>>>>
> = {
  'claude-agent-sdk': {
    'metered-api': new Set(['ANTHROPIC_API_KEY']),
  },
  'claude-code-cli': {
    'metered-api': new Set(['ANTHROPIC_API_KEY']),
  },
  'claude-code-local': {
    'metered-api': new Set(['ANTHROPIC_API_KEY']),
  },
  codex: {
    'metered-api': new Set(['OPENAI_API_KEY']),
  },
};

/**
 * Credential lanes are an exact per-runtime/per-kind contract, not a generic
 * environment escape hatch. Subscription lanes rely on their isolated CLI
 * profiles and therefore accept no injected environment values. Metered lanes
 * accept only the provider API key explicitly reviewed for that runtime.
 */
export function isReviewedRuntimeCredentialLaneEnvironmentKey(
  key: string,
  runtime: string | undefined,
  kind: string | undefined,
): boolean {
  const normalizedKey = key.toUpperCase();
  if (key !== normalizedKey) return false;
  const normalizedRuntime = runtime === 'codex-cli'
    ? 'codex'
    : String(runtime || '').toLowerCase();
  const normalizedKind = String(kind || '').toLowerCase();
  return REVIEWED_RUNTIME_LANE_CREDENTIALS[normalizedRuntime]?.[normalizedKind]
    ?.has(normalizedKey) === true;
}

export function isReservedRuntimeCredentialLaneEnvironmentKey(
  key: string,
  runtime?: string,
  kind?: string,
): boolean {
  const normalized = key.toUpperCase();
  if (isReviewedRuntimeCredentialLaneEnvironmentKey(key, runtime, kind)) {
    return false;
  }
  return true;
}

export function mergeAgentEnvironmentLayers(
  ...layers: Array<Record<string, string> | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const layer of layers) {
    if (!layer) continue;
    Object.assign(merged, layer);
  }
  return merged;
}

/**
 * Resolve the preferred top-level `env` contract with compatibility support
 * for the formerly documented `resources.env` location.
 */
export function resolveAgentEnvironment(source: AgentEnvironmentSource): Record<string, string> {
  return mergeAgentEnvironmentLayers(
    source.resources?.env as Record<string, string> | undefined,
    source.env as Record<string, string> | undefined,
  );
}

/**
 * Defense-in-depth for metadata loaded from the database. Config validation
 * rejects invalid or reserved declarations; this filter ensures a stale or
 * manually modified row still cannot override the managed worker envelope.
 */
export function sanitizeAgentEnvironment(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const sanitized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      AGENT_ENV_KEY_PATTERN.test(key)
      && !isReservedAgentEnvironmentKey(key)
      && typeof entry === 'string'
    ) {
      sanitized[key] = entry;
    }
  }
  return sanitized;
}
