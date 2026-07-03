// SPDX-License-Identifier: MIT
/**
 * Runtime registry.
 *
 * Central source of truth for runtime defaults, labels, auth mode, and
 * capabilities. Existing harness identifiers remain intact so this layer can
 * be adopted incrementally without changing external config.
 */

import type { HarnessType } from '../harness/types.js';
import type { RuntimeInterfaceProfile, RuntimeProfile, RuntimeId, RuntimeValidationIssue } from './types.js';
import { execFileSync, spawnSync } from 'child_process';

const DEFAULT_RUNTIME: RuntimeId = 'claude-agent-sdk';
const RUNTIME_ALIASES: Record<string, RuntimeId> = {
  'codex-cli': 'codex',
};
const PROVIDER_RUNTIME_PREFIX = 'provider:';
const RUNTIME_INTERFACE_VERSION = 'id-agents-runtime-v1';
const RUNTIME_INTERFACE_ENDPOINTS = {
  discovery: '/.well-known/restap.json',
  talk: '/talk',
  news: '/news',
  newsPost: '/news',
  catalog: '/catalog',
} as const;
const RUNTIME_INTERFACE_DRIVER = {
  interface: 'AgentHarness',
  input: 'prompt:string + HarnessOptions',
  output: 'AsyncGenerator<HarnessMessage>',
  eventTypes: ['system', 'tool_use', 'result', 'error', 'progress', 'thinking'],
} as const;

const PROFILES: Record<RuntimeId, RuntimeProfile> = {
  'claude-agent-sdk': {
    id: 'claude-agent-sdk',
    canonicalId: 'claude-agent-sdk',
    displayName: 'Claude',
    providerName: 'Claude Agent SDK',
    defaultModel: 'claude-haiku-4-5-20251001',
    sessionPolicy: 'persistent',
    deploymentShape: 'local-process',
    auth: {
      mode: 'api-key',
      provider: 'Anthropic',
      requiredEnv: ['ANTHROPIC_API_KEY'],
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: true,
      supportsAllowedTools: true,
    },
  },
  'claude-code-cli': {
    id: 'claude-code-cli',
    canonicalId: 'claude-code-cli',
    displayName: 'Claude Code',
    providerName: 'Claude Code CLI',
    defaultModel: 'claude-opus-4-20250514',
    sessionPolicy: 'persistent',
    deploymentShape: 'local-process',
    auth: {
      mode: 'cli-login',
      provider: 'Anthropic',
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: true,
      supportsAllowedTools: true,
    },
  },
  'claude-code-local': {
    id: 'claude-code-local',
    canonicalId: 'claude-code-cli',
    displayName: 'Claude Code',
    providerName: 'Claude Code CLI',
    defaultModel: 'claude-opus-4-20250514',
    sessionPolicy: 'persistent',
    deploymentShape: 'local-process',
    auth: {
      mode: 'cli-login',
      provider: 'Anthropic',
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: true,
      supportsAllowedTools: true,
    },
  },
  codex: {
    id: 'codex',
    canonicalId: 'codex',
    displayName: 'Codex',
    providerName: 'Codex CLI',
    defaultModel: '',  // let Codex CLI pick model based on account; override per-agent in YAML
    // `codex exec resume <thread_id>` restores prior conversation context (verified
    // on codex-cli 0.130 — needs an explicit -m model). The harness resumes when a
    // per-conversation thread id is provided, so chats stay isolated.
    sessionPolicy: 'resume-by-id',
    deploymentShape: 'local-process',
    auth: {
      mode: 'cli-login',
      provider: 'OpenAI',
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: true,
      supportsAllowedTools: true,
    },
  },
  'cursor-cli': {
    id: 'cursor-cli',
    canonicalId: 'cursor-cli',
    displayName: 'Cursor',
    providerName: 'Cursor Agent CLI',
    defaultModel: 'sonnet-4',
    sessionPolicy: 'persistent',
    deploymentShape: 'local-process',
    auth: {
      mode: 'cli-login',
      provider: 'Cursor',
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: false,
      supportsAllowedTools: false,
    },
  },
  copilot: {
    id: 'copilot',
    canonicalId: 'copilot',
    displayName: 'GitHub Copilot',
    providerName: 'GitHub Copilot CLI',
    defaultModel: 'default',
    sessionPolicy: 'fresh-per-query',
    deploymentShape: 'local-process',
    auth: {
      mode: 'cli-login',
      provider: 'GitHub',
    },
    capabilities: {
      supportsResume: false,
      supportsPlugins: false,
      supportsAllowedTools: false,
    },
  },
  grok: {
    id: 'grok',
    canonicalId: 'grok',
    displayName: 'Grok Build',
    providerName: 'Grok Build CLI',
    defaultModel: 'grok-composer-2.5-fast',
    sessionPolicy: 'resume-by-id',
    deploymentShape: 'local-process',
    auth: {
      mode: 'cli-login',
      provider: 'xAI',
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: false,
      supportsAllowedTools: false,
    },
  },
  antigravity: {
    id: 'antigravity',
    canonicalId: 'antigravity',
    displayName: 'Google Antigravity',
    providerName: 'Google Antigravity CLI',
    defaultModel: 'Gemini 3.5 Flash (Medium)',
    sessionPolicy: 'resume-by-id',
    deploymentShape: 'local-process',
    auth: {
      mode: 'cli-login',
      provider: 'Google',
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: false,
      supportsAllowedTools: false,
    },
  },
  'kiro-cli': {
    id: 'kiro-cli',
    canonicalId: 'kiro-cli',
    displayName: 'Kiro',
    providerName: 'Kiro CLI',
    defaultModel: 'auto',
    sessionPolicy: 'resume-by-id',
    deploymentShape: 'local-process',
    auth: {
      mode: 'cli-login',
      provider: 'Kiro',
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: false,
      supportsAllowedTools: false,
    },
  },
  ollama: {
    id: 'ollama',
    canonicalId: 'ollama',
    displayName: 'Ollama (Local)',
    providerName: 'Ollama',
    defaultModel: 'qwen3:4b',
    sessionPolicy: 'fresh-per-query',
    deploymentShape: 'local-process',
    auth: {
      mode: 'api-key',
      provider: 'Ollama',
      requiredEnv: [],
    },
    capabilities: {
      supportsResume: false,
      supportsPlugins: false,
      supportsAllowedTools: false,
    },
  },
  'provider-api': {
    id: 'provider-api',
    canonicalId: 'provider-api',
    displayName: 'API Provider',
    providerName: 'OpenAI-compatible API',
    defaultModel: '',
    sessionPolicy: 'fresh-per-query',
    deploymentShape: 'local-process',
    auth: {
      mode: 'api-key',
      provider: 'IDACC provider lane',
      requiredEnv: ['ID_PROVIDER_BASE_URL', 'ID_PROVIDER_API_KEY'],
    },
    capabilities: {
      supportsResume: false,
      supportsPlugins: false,
      supportsAllowedTools: false,
    },
  },
  'public-agent-remote': {
    id: 'public-agent-remote',
    canonicalId: 'public-agent-remote',
    displayName: 'Public Agent (Remote)',
    providerName: 'Public Agent (Remote)',
    defaultModel: 'unknown',
    sessionPolicy: 'remote-owned',
    deploymentShape: 'remote-endpoint',
    auth: {
      mode: 'ssh-tunnel',
    },
    capabilities: {
      supportsResume: false,
      supportsPlugins: false,
      supportsAllowedTools: false,
    },
  },
};

export function getDefaultRuntime(): RuntimeId {
  return DEFAULT_RUNTIME;
}

export function getRuntimeProfile(runtime: HarnessType | string | undefined): RuntimeProfile {
  if (isProviderRuntimeSpecifier(runtime)) return PROFILES['provider-api'];
  const alias = runtime ? RUNTIME_ALIASES[runtime] : undefined;
  const id = isRuntimeId(runtime) ? runtime : alias || DEFAULT_RUNTIME;
  return PROFILES[id];
}

export function getRuntimeInterfaceProfile(runtime: HarnessType | string | undefined): RuntimeInterfaceProfile {
  const profile = getRuntimeProfile(runtime);
  return {
    version: RUNTIME_INTERFACE_VERSION,
    protocol: 'rest-ap',
    protocolVersion: '1.0',
    adapterContract: 'id-agents-harness-v1',
    runtime: profile.id,
    providerName: profile.providerName,
    sessionPolicy: profile.sessionPolicy,
    deploymentShape: profile.deploymentShape,
    requiredEndpoints: { ...RUNTIME_INTERFACE_ENDPOINTS },
    driver: {
      ...RUNTIME_INTERFACE_DRIVER,
      eventTypes: [...RUNTIME_INTERFACE_DRIVER.eventTypes],
    },
    capabilities: { ...profile.capabilities },
  };
}

export function resolveRuntime(runtime: HarnessType | string | undefined): RuntimeId {
  return getRuntimeProfile(runtime).id;
}

export function isProviderRuntimeSpecifier(runtime: string | undefined): boolean {
  return !!runtime && runtime.startsWith(PROVIDER_RUNTIME_PREFIX) && runtime.length > PROVIDER_RUNTIME_PREFIX.length;
}

export function getRuntimeDisplayName(runtime: HarnessType | string | undefined): string {
  return getRuntimeProfile(runtime).displayName;
}

export function getRuntimeProviderName(runtime: HarnessType | string | undefined): string {
  return getRuntimeProfile(runtime).providerName;
}

export function getRuntimeAuthProvider(runtime: HarnessType | string | undefined): string {
  return getRuntimeProfile(runtime).auth.provider ?? '';
}

export function getDefaultModelForRuntime(
  runtime: HarnessType | string | undefined,
  configuredDefault?: string
): string {
  return configuredDefault || getRuntimeProfile(runtime).defaultModel;
}

export function usesCliLogin(runtime: HarnessType | string | undefined): boolean {
  return getRuntimeProfile(runtime).auth.mode === 'cli-login';
}

export function supportsSessionResume(runtime: HarnessType | string | undefined): boolean {
  return getRuntimeProfile(runtime).capabilities.supportsResume;
}

/**
 * Runtime-specific filesystem paths for agent templates, skills, and personality files.
 *
 * Claude runtimes use .claude/ conventions (CLAUDE.md, .claude/skills/, .claude/agents/).
 * Codex uses .agents/ conventions (AGENTS.md at project root, .agents/skills/, .agents/{name}/).
 */
export interface RuntimePaths {
  /** Directory containing agent templates, relative to workingDir (e.g. '.claude/agents' or '.agents') */
  templateDir: string;
  /** Where overlay contents are copied to, relative to workingDir (e.g. '.claude' or '.agents') */
  overlayTarget: string;
  /** Directory for deployed skills, relative to workingDir (e.g. '.claude/skills' or '.agents/skills') */
  skillsDir: string;
  /** Personality/instructions file path, relative to workingDir (e.g. '.claude/CLAUDE.md' or 'AGENTS.md') */
  personalityFile: string;
  /** Filename for the personality file inside a template directory (e.g. 'CLAUDE.md' or 'AGENTS.md') */
  personalityFilename: string;
}

export function getRuntimePaths(runtime: HarnessType | string | undefined): RuntimePaths {
  const resolved = resolveRuntime(runtime);
  if (resolved === 'codex' || resolved === 'grok' || resolved === 'antigravity' || resolved === 'copilot' || resolved === 'kiro-cli' || resolved === 'ollama' || resolved === 'provider-api') {
    return {
      templateDir: '.agents',
      overlayTarget: '.agents',
      skillsDir: '.agents/skills',
      personalityFile: 'AGENTS.md',
      personalityFilename: 'AGENTS.md',
    };
  }
  if (resolved === 'cursor-cli') {
    return {
      templateDir: '.cursor/agents',
      overlayTarget: '.cursor',
      skillsDir: '.cursor/skills',
      personalityFile: 'AGENTS.md',
      personalityFilename: 'AGENTS.md',
    };
  }
  // All Claude runtimes: claude-agent-sdk, claude-code-cli, claude-code-local
  return {
    templateDir: '.claude/agents',
    overlayTarget: '.claude',
    skillsDir: '.claude/skills',
    personalityFile: '.claude/CLAUDE.md',
    personalityFilename: 'CLAUDE.md',
  };
}

export function getAvailableRuntimes(): RuntimeId[] {
  return Object.keys(PROFILES) as RuntimeId[];
}

export function isRuntimeId(runtime: string | undefined): runtime is RuntimeId {
  return !!runtime && runtime in PROFILES;
}

export function isSupportedRuntimeSpecifier(runtime: string | undefined): boolean {
  return !!runtime && (runtime in PROFILES || runtime in RUNTIME_ALIASES || isProviderRuntimeSpecifier(runtime));
}

/**
 * Returns true only for runtimes whose deployment shape is 'remote-endpoint'.
 *
 * Use this single gate in spawners, launchers, lifecycle endpoints, and log-tailers
 * to short-circuit all local-process logic for remote-endpoint runtimes.
 *
 * Currently the only remote-endpoint runtime is 'public-agent-remote'. Additional
 * remote-endpoint runtimes added in the future will be detected automatically via
 * the profile's deploymentShape field.
 */
export function isRemoteEndpointRuntime(runtime: string | undefined): boolean {
  if (!runtime || !(runtime in PROFILES)) return false;
  return PROFILES[runtime as RuntimeId].deploymentShape === 'remote-endpoint';
}

function classifyModelFamily(model: string | undefined): 'claude' | 'openai' | 'unknown' {
  if (!model) return 'unknown';
  const normalized = model.trim().toLowerCase();

  if (['haiku', 'sonnet', 'opus', 'fable', 'fable-5', 'mythos', 'mythos-5'].includes(normalized) || normalized.startsWith('claude')) {
    return 'claude';
  }

  if (
    normalized.startsWith('codex-') ||
    normalized.startsWith('gpt-') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  ) {
    return 'openai';
  }

  return 'unknown';
}

export function validateRuntimeModelCompatibility(
  runtime: HarnessType | string | undefined,
  model: string | undefined
): RuntimeValidationIssue[] {
  if (!model) return [];

  const resolvedRuntime = resolveRuntime(runtime);
  const family = classifyModelFamily(model);
  const issues: RuntimeValidationIssue[] = [];

  // Cursor, Grok, Antigravity, Copilot, Kiro, Ollama, and provider-api accept provider-owned model strings.
  if (resolvedRuntime === 'cursor-cli' || resolvedRuntime === 'grok' || resolvedRuntime === 'antigravity' || resolvedRuntime === 'copilot' || resolvedRuntime === 'kiro-cli' || resolvedRuntime === 'ollama' || resolvedRuntime === 'provider-api') return issues;

  if (resolvedRuntime === 'codex' && family === 'claude') {
    issues.push({
      code: 'runtime_model_mismatch',
      message: `runtime "${resolvedRuntime}" is incompatible with Claude model "${model}"`,
    });
  }

  if (resolvedRuntime !== 'codex' && family === 'openai') {
    issues.push({
      code: 'runtime_model_mismatch',
      message: `runtime "${resolvedRuntime}" is incompatible with OpenAI model "${model}"`,
    });
  }

  return issues;
}

function checkCommandAvailable(command: string): RuntimeValidationIssue[] {
  try {
    execFileSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return [];
  } catch {
    return [{
      code: 'runtime_binary_missing',
      message: `required runtime command "${command}" is not installed or not on PATH`,
    }];
  }
}

function firstAvailableCommand(commands: string[]): string | null {
  for (const command of commands) {
    if (checkCommandAvailable(command).length === 0) return command;
  }
  return null;
}

/**
 * Map a preflight issue code to a one-line setup hint shown at spawn time.
 * Returns null for codes without a curated hint; callers should fall back to issue.message.
 */
export function runtimeIssueHint(code: string): string | null {
  switch (code) {
    case 'anthropic_api_key_missing':
      return 'Missing ANTHROPIC_API_KEY. Add `export ANTHROPIC_API_KEY=sk-...` to ~/.zshrc (or ~/.bashrc) or to a project .env. Get a key: https://console.anthropic.com/settings/keys';
    case 'codex_auth_missing':
      return 'Missing OPENAI_API_KEY. Add `export OPENAI_API_KEY=sk-...` to ~/.zshrc (or ~/.bashrc) or to a project .env, or run `codex login`. Docs: https://github.com/openai/codex';
    case 'cursor_auth_missing':
      return 'Cursor Agent CLI is not authenticated. Set `CURSOR_API_KEY` or run `cursor-agent login` on this host. Install: curl https://cursor.com/install -fsS | bash';
    case 'grok_auth_missing':
      return 'Grok Build CLI is not authenticated. Run `grok login` on this host, then retry.';
    case 'antigravity_auth_missing':
      return 'Google Antigravity CLI is not authenticated. Run `agy` or `antigravity` on this host to complete sign-in, then retry.';
    case 'kiro_auth_missing':
      return 'Kiro CLI is not authenticated. Run `kiro-cli login` on this host, then retry.';
    default:
      return null;
  }
}

export function validateRuntimePreflight(
  runtime: HarnessType | string | undefined,
  model?: string
): RuntimeValidationIssue[] {
  const resolvedRuntime = resolveRuntime(runtime);
  const issues: RuntimeValidationIssue[] = [
    ...validateRuntimeModelCompatibility(resolvedRuntime, model),
  ];

  if (resolvedRuntime === 'claude-agent-sdk') {
    if (!process.env.ANTHROPIC_API_KEY) {
      issues.push({
        code: 'anthropic_api_key_missing',
        message: 'runtime "claude-agent-sdk" requires ANTHROPIC_API_KEY',
      });
    }
    return issues;
  }

  if (resolvedRuntime === 'claude-code-cli' || resolvedRuntime === 'claude-code-local') {
    return [...issues, ...checkCommandAvailable('claude')];
  }

  if (resolvedRuntime === 'cursor-cli') {
    issues.push(...checkCommandAvailable('cursor-agent'));
    if (!process.env.CURSOR_API_KEY) {
      try {
        const result = spawnSync('cursor-agent', ['status'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        });
        const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
        if (/not logged in/i.test(combinedOutput)) {
          issues.push({
            code: 'cursor_auth_missing',
            message: 'runtime "cursor-cli" requires CURSOR_API_KEY or an active `cursor-agent login` session',
          });
        }
      } catch {
        issues.push({
          code: 'cursor_auth_missing',
          message: 'runtime "cursor-cli" requires CURSOR_API_KEY or an active `cursor-agent login` session',
        });
      }
    }
    return issues;
  }

  if (resolvedRuntime === 'copilot') {
    return [...issues, ...checkCommandAvailable('copilot')];
  }

  if (resolvedRuntime === 'grok') {
    issues.push(...checkCommandAvailable('grok'));
    try {
      const result = spawnSync('grok', ['models'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      });
      const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (result.status !== 0 || !/available models/i.test(combinedOutput) || /not authenticated|not logged in|signed out|login required/i.test(combinedOutput)) {
        issues.push({
          code: 'grok_auth_missing',
          message: 'runtime "grok" requires an active `grok login` session',
        });
      }
    } catch {
      issues.push({
        code: 'grok_auth_missing',
        message: 'runtime "grok" requires an active `grok login` session',
      });
    }
    return issues;
  }

  if (resolvedRuntime === 'antigravity') {
    const command = firstAvailableCommand(['agy', 'antigravity']);
    if (!command) {
      issues.push({
        code: 'runtime_binary_missing',
        message: 'required runtime command "agy" or "antigravity" is not installed or not on PATH',
      });
      return issues;
    }
    try {
      const result = spawnSync(command, ['models'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      });
      const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (result.status !== 0 || !combinedOutput.trim() || /not authenticated|not logged in|signed out|login required/i.test(combinedOutput)) {
        issues.push({
          code: 'antigravity_auth_missing',
          message: 'runtime "antigravity" requires an active Antigravity CLI sign-in session',
        });
      }
    } catch {
      issues.push({
        code: 'antigravity_auth_missing',
        message: 'runtime "antigravity" requires an active Antigravity CLI sign-in session',
      });
    }
    return issues;
  }

  if (resolvedRuntime === 'kiro-cli') {
    issues.push(...checkCommandAvailable('kiro-cli'));
    try {
      const result = spawnSync('kiro-cli', ['whoami'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (result.status !== 0 || /not logged in|not authenticated|signed out|login required/i.test(combinedOutput)) {
        issues.push({
          code: 'kiro_auth_missing',
          message: 'runtime "kiro-cli" requires an active `kiro-cli login` session',
        });
      }
    } catch {
      issues.push({
        code: 'kiro_auth_missing',
        message: 'runtime "kiro-cli" requires an active `kiro-cli login` session',
      });
    }
    return issues;
  }

  if (resolvedRuntime === 'provider-api') {
    if (!process.env.ID_PROVIDER_BASE_URL && !process.env.OPENAI_BASE_URL) {
      issues.push({
        code: 'provider_api_base_url_missing',
        message: 'runtime "provider-api" requires ID_PROVIDER_BASE_URL or OPENAI_BASE_URL',
      });
    }
    if (!process.env.ID_PROVIDER_API_KEY && !process.env.OPENAI_API_KEY) {
      issues.push({
        code: 'provider_api_key_missing',
        message: 'runtime "provider-api" requires ID_PROVIDER_API_KEY or OPENAI_API_KEY',
      });
    }
    return issues;
  }

  if (resolvedRuntime === 'codex') {
    issues.push(...checkCommandAvailable('codex'));
    if (!process.env.OPENAI_API_KEY) {
      try {
        const result = spawnSync('codex', ['login', 'status'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        });
        const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
        if (result.status !== 0 && !/logged in/i.test(combinedOutput)) {
          issues.push({
            code: 'codex_auth_missing',
            message: 'runtime "codex" requires OPENAI_API_KEY or an active `codex login` session',
          });
        }
      } catch {
        issues.push({
          code: 'codex_auth_missing',
          message: 'runtime "codex" requires OPENAI_API_KEY or an active `codex login` session',
        });
      }
    }
  }

  return issues;
}
