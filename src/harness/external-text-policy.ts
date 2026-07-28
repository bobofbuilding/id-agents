// SPDX-License-Identifier: MIT

import type { HarnessOptions, McpServerSpec } from './types.js';

export const EXTERNAL_TEXT_ONLY_MAX_TOKENS = 1024;

export interface PlainTextExecutionBoundary {
  externalTextOnly: boolean;
  mcpServers: McpServerSpec[] | undefined;
  workingDirectory: string | undefined;
  maxTokens: number;
}

/**
 * Defense-in-depth for plain-text HTTP runtimes. The Manager already strips
 * these fields, but harnesses must not expose local context or MCP tools if a
 * future caller invokes the policy directly.
 */
export function plainTextExecutionBoundary(
  options: HarnessOptions,
  configuredMaxTokens: number,
): PlainTextExecutionBoundary {
  const externalTextOnly = options.executionPolicy === 'external-text-only';
  return {
    externalTextOnly,
    mcpServers: externalTextOnly ? undefined : options.mcpServers,
    workingDirectory: externalTextOnly ? undefined : options.workingDirectory,
    maxTokens: externalTextOnly
      ? EXTERNAL_TEXT_ONLY_MAX_TOKENS
      : configuredMaxTokens,
  };
}
