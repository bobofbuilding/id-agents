// SPDX-License-Identifier: MIT
/**
 * Harness Module
 *
 * Factory for creating agent execution harnesses.
 * - claude-code: Uses Claude Agent SDK
 * - claude-code-cli: Uses Claude Code CLI (for local agents with user auth)
 */

import { HarnessType, AgentHarness } from './types.js';
import { ClaudeAgentSdkHarness } from './claude-agent-sdk.js';
import { ClaudeCodeCliHarness } from './claude-code-cli.js';
import { CodexHarness } from './codex.js';
import { CursorCliHarness } from './cursor-cli.js';
import { GrokHarness } from './grok.js';
import { AntigravityHarness } from './antigravity.js';
import { CopilotCliHarness } from './copilot-cli.js';
import { KiroCliHarness } from './kiro-cli.js';
import { KimiCliHarness } from './kimi-cli.js';
import { OllamaHarness } from './ollama.js';
import { ProviderApiHarness } from './provider-api.js';
import { getAvailableRuntimes, isRuntimeId } from '../runtime/registry.js';

// Export all types
export * from './types.js';
export { ClaudeAgentSdkHarness } from './claude-agent-sdk.js';
export { ClaudeCodeCliHarness } from './claude-code-cli.js';
export { CodexHarness } from './codex.js';
export { CursorCliHarness } from './cursor-cli.js';
export { GrokHarness } from './grok.js';
export { AntigravityHarness } from './antigravity.js';
export { CopilotCliHarness } from './copilot-cli.js';
export { KiroCliHarness } from './kiro-cli.js';
export { KimiCliHarness } from './kimi-cli.js';
export { OllamaHarness } from './ollama.js';
export { ProviderApiHarness } from './provider-api.js';
export * from './rate-limit.js';

/**
 * Create a harness instance by type.
 *
 * @param type The harness type
 * @returns An AgentHarness instance
 * @throws Error if the harness type is unknown
 */
export function createHarness(type: HarnessType = 'claude-agent-sdk'): AgentHarness {
  switch (type) {
    case 'claude-agent-sdk':
      return new ClaudeAgentSdkHarness();
    case 'claude-code-cli':
    case 'claude-code-local':  // Local agents use the CLI harness
      return new ClaudeCodeCliHarness();
    case 'codex':
      return new CodexHarness();
    case 'cursor-cli':
      return new CursorCliHarness();
    case 'grok':
      return new GrokHarness();
    case 'antigravity':
      return new AntigravityHarness();
    case 'copilot':
      return new CopilotCliHarness();
    case 'kiro-cli':
      return new KiroCliHarness();
    case 'kimi-cli':
      return new KimiCliHarness();
    case 'ollama':
      return new OllamaHarness();
    case 'provider-api':
      return new ProviderApiHarness();
    default:
      throw new Error(`Unknown harness type: ${type}. Valid types: claude-agent-sdk, claude-code-cli, codex, cursor-cli, grok, antigravity, copilot, kiro-cli, kimi-cli, ollama, provider-api`);
  }
}

/**
 * Get all available harness types.
 */
export function getAvailableHarnesses(): HarnessType[] {
  return getAvailableRuntimes();
}

/**
 * Check if a harness type is valid.
 */
export function isValidHarnessType(type: string): type is HarnessType {
  return isRuntimeId(type);
}
