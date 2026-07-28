// SPDX-License-Identifier: MIT
/**
 * Parent Claude-Code session env-var hygiene.
 *
 * When the manager is launched from a shell that is itself running inside a
 * Claude Code session (`!<cmd>` inside claude, IDE integrated terminal, a tmux
 * pane spawned from inside claude, etc.), the shell inherits env vars that
 * hand off the parent's auth/session to any child process. If we forward those
 * to a spawned child agent, the child `claude` CLI honors the parent's
 * host-managed OAuth token ahead of its own keychain login and returns 401 on
 * every dispatch.
 *
 * Keychain-login users are the ones affected; `ANTHROPIC_API_KEY` users are
 * immune because the CLI prefers the API key.
 */

/**
 * Vars the parent Claude Code session uses to hand off auth/session state.
 * These MUST be stripped before spawning child agents.
 */
export const SESSION_HANDOFF_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_AGENT_SDK_VERSION',
] as const;

export type SessionHandoffVar = typeof SESSION_HANDOFF_VARS[number];

const REVIEWED_CLAUDE_CONFIG_VARS = new Set([
  'CLAUDE_MODEL',
]);

/**
 * Return only the reviewed, non-secret Claude worker configuration. This is
 * deliberately an allowlist: new CLAUDE_* variables may carry authentication,
 * provider routing, or host-session state and must not cross the Manager
 * boundary until reviewed.
 */
export function filterClaudeEnvVars(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!REVIEWED_CLAUDE_CONFIG_VARS.has(k)) continue;
    if (typeof v !== 'string' || !v) continue;
    out[k] = v;
  }
  return out;
}

/** Return the subset of `env` keys that are session-handoff vars. */
export function detectSessionHandoffVars(
  env: NodeJS.ProcessEnv,
): SessionHandoffVar[] {
  return SESSION_HANDOFF_VARS.filter((k) => env[k] !== undefined);
}
