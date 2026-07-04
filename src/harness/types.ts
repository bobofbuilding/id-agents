// SPDX-License-Identifier: MIT
/**
 * Harness Abstraction Types
 *
 * Defines the interface for agent execution harnesses.
 * All harnesses produce the same message format for REST-AP compatibility.
 */

export type HarnessType = 'claude-agent-sdk' | 'claude-code-cli' | 'claude-code-local' | 'codex' | 'cursor-cli' | 'grok' | 'antigravity' | 'copilot' | 'kiro-cli' | 'public-agent-remote' | 'ollama' | 'provider-api';

export interface PluginConfig {
  name: string;
  path: string;
}

/** Transport used to reach an MCP server. */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * Normalized MCP server definition. Serializable across the spawn boundary
 * (env var / JSON), unlike the SDK's in-process `sdk` transport. A harness
 * maps this onto whatever its underlying tool expects (the Claude Agent SDK
 * `Options.mcpServers`, a `.mcp.json` file, etc.).
 */
export interface McpServerSpec {
  /** Unique name; becomes the key in the SDK's mcpServers record. */
  name: string;
  /** stdio (spawn a command) | http | sse. Defaults to stdio. */
  transport?: McpTransport;
  /** stdio: executable to spawn. */
  command?: string;
  /** stdio: arguments for the command. */
  args?: string[];
  /** stdio: extra environment for the spawned server. */
  env?: Record<string, string>;
  /** http/sse: server URL. */
  url?: string;
  /** http/sse: extra request headers (e.g. Authorization). */
  headers?: Record<string, string>;
}

export interface HarnessOptions {
  model?: string;
  workingDirectory?: string;
  plugins?: PluginConfig[];
  /** External MCP servers to expose as tools (Claude runtimes only). */
  mcpServers?: McpServerSpec[];
  allowedTools?: string[];
  /**
   * Runtime permission envelope for this dispatch. `control-plane-readonly`
   * is for manager/status/review prompts that should not edit files or run
   * unrestricted shell commands.
   */
  executionPolicy?: 'default' | 'control-plane-readonly';
  resume?: string;
  env?: Record<string, string | undefined>;
  /** The originating dispatch's query id, threaded through so live activity
   *  steps can be attributed to the exact query (per-dispatch trace). */
  queryId?: string;
}

/**
 * Unified message format from all harnesses.
 * Maps to REST-AP response format.
 */
export interface HarnessMessage {
  type: 'system' | 'tool_use' | 'result' | 'error' | 'progress' | 'thinking';
  subtype?: string;
  content?: string;
  result?: string;
  session_id?: string;
  tool_name?: string;
  parent_tool_use_id?: string;
  [key: string]: any;
}

/**
 * Agent harness interface.
 * Implementations wrap different AI coding CLIs (Claude Code, Open Code, etc.)
 */
export interface AgentHarness {
  /** Harness identifier */
  readonly type: HarnessType;

  /**
   * Execute a prompt and yield messages as they arrive.
   * @param prompt The task/prompt to execute
   * @param options Harness configuration options
   * @yields HarnessMessage objects as execution progresses
   */
  run(prompt: string, options: HarnessOptions): AsyncGenerator<HarnessMessage>;

  /**
   * Cancel the currently running query.
   * Kills the underlying process if one is running.
   * @returns true if a process was cancelled, false if nothing was running
   */
  cancel?(): boolean;
}
