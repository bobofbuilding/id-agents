// SPDX-License-Identifier: MIT
/**
 * Runtime metadata and capability types.
 *
 * Runtime profiles describe how an agent executes LLM work. They are separate
 * from agent topology (`type`) so new runtimes can be added without spreading
 * provider-specific conditionals through the codebase.
 */

import type { HarnessType } from '../harness/types.js';

export type RuntimeId = HarnessType;

export type RuntimeSessionPolicy = 'persistent' | 'fresh-per-query' | 'resume-by-id' | 'remote-owned';

export type DeploymentShape = 'local-process' | 'remote-endpoint';

export interface RuntimeAuthConfig {
  mode: 'api-key' | 'cli-login' | 'ssh-tunnel';
  provider?: string;
  requiredEnv?: string[];
}

export interface RuntimeCapabilities {
  supportsResume: boolean;
  supportsPlugins: boolean;
  supportsAllowedTools: boolean;
}

export type RuntimeInterfaceProtocol = 'rest-ap';
export type RuntimeAdapterContract = 'id-agents-harness-v1';

export interface RuntimeInterfaceProfile {
  /** Stable contract version external runtimes can target. */
  version: string;
  /** Wire protocol exposed to callers and peer agents. */
  protocol: RuntimeInterfaceProtocol;
  protocolVersion: string;
  /** Internal adapter boundary used by local-process runtimes. */
  adapterContract: RuntimeAdapterContract;
  runtime: RuntimeId;
  providerName: string;
  sessionPolicy: RuntimeSessionPolicy;
  deploymentShape: DeploymentShape;
  requiredEndpoints: {
    discovery: string;
    talk: string;
    news: string;
    newsPost: string;
    catalog: string;
  };
  driver: {
    interface: 'AgentHarness';
    input: 'prompt:string + HarnessOptions';
    output: 'AsyncGenerator<HarnessMessage>';
    eventTypes: Array<'system' | 'tool_use' | 'result' | 'error' | 'progress' | 'thinking'>;
  };
  capabilities: RuntimeCapabilities;
}

export interface RuntimeProfile {
  id: RuntimeId;
  canonicalId: RuntimeId;
  displayName: string;
  providerName: string;
  defaultModel: string;
  sessionPolicy: RuntimeSessionPolicy;
  deploymentShape: DeploymentShape;
  auth: RuntimeAuthConfig;
  capabilities: RuntimeCapabilities;
}

export interface RuntimeValidationIssue {
  code: string;
  message: string;
}
