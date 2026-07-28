// SPDX-License-Identifier: MIT
/**
 * Claude Code Harness
 *
 * Wraps the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) as a harness.
 */

import {
  query,
  type CanUseTool,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType, PluginConfig } from './types.js';
import {
  exactWholeToolNames,
  filterMcpServersForAllowedTools,
  isNamespacedMcpTool,
  toMcpServerRecord,
} from './mcp.js';

// Available Claude models
export const CLAUDE_MODELS = {
  HAIKU: 'claude-haiku-4-5-20251001',
  SONNET: 'claude-sonnet-4-20250514',
  OPUS: 'claude-opus-4-20250514',
  FABLE: 'claude-fable-5',
  MYTHOS: 'claude-mythos-5'
} as const;

export function claudeSdkToolPolicy(
  options: Pick<HarnessOptions, 'allowedTools' | 'executionPolicy'>,
): Pick<Options, 'allowedTools' | 'canUseTool' | 'permissionMode' | 'tools'> {
  const exactAllowedTools = options.executionPolicy === 'external-text-only'
    ? []
    : options.allowedTools;
  if (exactAllowedTools !== undefined) {
    const wholeToolNames = exactWholeToolNames(exactAllowedTools);
    const allowed = new Set(wholeToolNames);
    const canUseTool: CanUseTool = async (toolName) => (
      allowed.has(toolName)
        ? { behavior: 'allow' }
        : {
            behavior: 'deny',
            message: `Tool "${toolName}" is outside this agent's exact allowedTools boundary`,
          }
    );
    const builtInTools = wholeToolNames.filter((tool) => !isNamespacedMcpTool(tool));
    return {
      tools: builtInTools,
      allowedTools: wholeToolNames,
      permissionMode: 'dontAsk',
      canUseTool,
    };
  }
  return {};
}

/**
 * Build the effective SDK launch contract in one place so the external
 * trust boundary cannot be weakened by a caller accidentally supplying
 * resume, plugin, MCP, or persistent-setting options.
 */
export function buildClaudeSdkOptions(
  options: HarnessOptions,
  model: string,
): Options {
  const externalTextOnly = options.executionPolicy === 'external-text-only';
  const configuredWorkingDirectory = options.workingDirectory?.trim();
  if (externalTextOnly && !configuredWorkingDirectory) {
    throw new Error('Claude Agent SDK external-text-only execution requires an isolated working directory');
  }
  const sdkOptions: Options = {
    model,
    cwd: configuredWorkingDirectory || process.cwd(),
    persistSession: !externalTextOnly,
    ...(externalTextOnly ? { settingSources: [] } : {}),
    ...claudeSdkToolPolicy(options),
  };

  if (!externalTextOnly && options.resume) {
    sdkOptions.resume = options.resume;
  }
  if (!externalTextOnly && options.plugins && options.plugins.length > 0) {
    sdkOptions.plugins = options.plugins.map(
      (plugin: PluginConfig) => ({ type: 'local' as const, path: plugin.path }),
    );
  }
  if (!externalTextOnly && options.mcpServers && options.mcpServers.length > 0) {
    const permittedMcpServers = filterMcpServersForAllowedTools(
      options.mcpServers,
      options.allowedTools,
    );
    const servers = toMcpServerRecord(permittedMcpServers);
    if (Object.keys(servers).length > 0) {
      sdkOptions.mcpServers = servers as Options['mcpServers'];
    }
  }

  // Explicitly setting sdkOptions.env without extra options causes "spawn node
  // ENOENT" in some SDK versions. When an override is necessary, retain the
  // inherited authentication environment.
  if (options.env && Object.keys(options.env).length > 0) {
    sdkOptions.env = {
      ...process.env,
      ...options.env,
    };
  }
  return sdkOptions;
}

/**
 * Map SDK message to unified HarnessMessage format
 */
function mapSDKMessage(message: SDKMessage): HarnessMessage | null {
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init') {
        return {
          type: 'system',
          subtype: 'init',
          session_id: message.session_id,
          content: `Model: ${message.model}, Tools: ${message.tools?.join(', ') || 'default'}`
        };
      }
      return null;

    case 'assistant':
      if (message.message?.content) {
        for (const block of message.message.content) {
          if ('type' in block && block.type === 'tool_use') {
            return {
              type: 'tool_use',
              tool_name: block.name,
              parent_tool_use_id: message.parent_tool_use_id || undefined,
              session_id: message.session_id
            };
          }
        }
      }
      return null;

    case 'result':
      if (message.subtype === 'success') {
        return {
          type: 'result',
          result: message.result,
          session_id: message.session_id
        };
      } else {
        const errorInfo = message as { subtype: string; errors?: string[]; session_id: string };
        const errors = errorInfo.errors ? errorInfo.errors.join(', ') : errorInfo.subtype;
        return {
          type: 'error',
          content: errors,
          session_id: errorInfo.session_id
        };
      }

    case 'tool_progress':
    case 'stream_event':
    case 'auth_status':
    default:
      return null;
  }
}

export class ClaudeAgentSdkHarness implements AgentHarness {
  readonly type: HarnessType = 'claude-agent-sdk';
  private abortController: AbortController | null = null;

  /**
   * Normalize model name - strips 'anthropic/' prefix if present for consistency
   * with OpenCode's provider/model format.
   *
   * Examples:
   *   anthropic/claude-sonnet-4-20250514 -> claude-sonnet-4-20250514
   *   claude-sonnet-4-20250514 -> claude-sonnet-4-20250514
   */
  private normalizeModel(model: string): string {
    if (model.startsWith('anthropic/')) {
      return model.substring('anthropic/'.length);
    }
    return model;
  }

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const rawModel = options.model || process.env.CLAUDE_MODEL || CLAUDE_MODELS.HAIKU;
    const model = this.normalizeModel(rawModel);
    const sdkOptions = buildClaudeSdkOptions(options, model);
    const abortController = new AbortController();
    this.abortController = abortController;
    sdkOptions.abortController = abortController;

    yield { type: 'system', subtype: 'init', content: 'Starting Claude Code harness' };

    try {
      let finalResult: string | undefined;

      for await (const message of query({ prompt, options: sdkOptions })) {
        const mapped = mapSDKMessage(message);
        if (mapped) {
          if (mapped.type === 'result' && mapped.result) {
            finalResult = mapped.result;
          }
          yield mapped;
        }
      }

      if (!finalResult) {
        yield { type: 'error', content: 'Claude Agent SDK returned no result' };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      yield { type: 'error', content: errorMessage };
      throw error;
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  cancel(): boolean {
    const abortController = this.abortController;
    if (!abortController) return false;
    this.abortController = null;
    abortController.abort();
    return true;
  }
}
