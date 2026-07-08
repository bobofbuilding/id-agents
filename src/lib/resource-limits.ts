// SPDX-License-Identifier: MIT

/**
 * Conservative defaults for local IDACC processes. Operators can override any
 * value with env, but the app should not start unconstrained Node/Ollama work by
 * default on a desktop machine.
 */

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function appendNodeOption(existing: string | undefined, option: string): string {
  const current = String(existing || '').trim();
  const flag = option.split('=')[0];
  if (new RegExp(`(^|\\s)${flag}(?:=|\\s|$)`).test(current)) return current;
  return [current, option].filter(Boolean).join(' ').trim();
}

export function nodeOptionsWithHeapLimit(existing?: string, heapMb = positiveIntEnv('ID_NODE_MAX_OLD_SPACE_MB', 768)): string {
  return appendNodeOption(existing, `--max-old-space-size=${heapMb}`);
}

export function nodeOptionsForAgent(existing?: string): string {
  return nodeOptionsWithHeapLimit(existing, positiveIntEnv('ID_AGENT_NODE_MAX_OLD_SPACE_MB', positiveIntEnv('ID_NODE_MAX_OLD_SPACE_MB', 768)));
}

export function nodeOptionsForManager(existing?: string): string {
  return nodeOptionsWithHeapLimit(existing, positiveIntEnv('ID_MANAGER_NODE_MAX_OLD_SPACE_MB', positiveIntEnv('ID_NODE_MAX_OLD_SPACE_MB', 1024)));
}

export function withDesktopResourceLimits(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = String(value);
  }

  merged.NODE_OPTIONS = nodeOptionsForAgent(merged.NODE_OPTIONS);

  // These are read by Ollama when its server starts. We also pass them to child
  // agents so local spawned Ollama/compatible helpers inherit bounded defaults.
  merged.OLLAMA_MAX_LOADED_MODELS ??= process.env.ID_OLLAMA_MAX_LOADED_MODELS || '1';
  merged.OLLAMA_NUM_PARALLEL ??= process.env.ID_OLLAMA_NUM_PARALLEL || '1';
  merged.OLLAMA_MAX_QUEUE ??= process.env.ID_OLLAMA_MAX_QUEUE || '4';
  merged.OLLAMA_KEEP_ALIVE ??= process.env.ID_OLLAMA_KEEP_ALIVE || '45s';
  merged.OLLAMA_MAX_CONCURRENT ??= process.env.ID_OLLAMA_MAX_CONCURRENT || '1';
  merged.OLLAMA_REQUEST_TIMEOUT_MS ??= process.env.ID_OLLAMA_REQUEST_TIMEOUT_MS || '300000';
  merged.PROVIDER_API_REQUEST_TIMEOUT_MS ??= process.env.ID_PROVIDER_API_REQUEST_TIMEOUT_MS || '300000';

  return merged;
}

