// SPDX-License-Identifier: MIT
/**
 * Dispatch capability preflight for the task-assignment path.
 *
 * Every agent registered today is assumed to have full HTTP/shell access
 * (the manager's REST task API), so this check is purely additive: an
 * agent only needs `metadata.capabilities` when it deviates from that
 * default. This keeps the preflight backward compatible with every
 * existing agent row while giving a clear, typed failure — instead of a
 * silently stranded `doing` task — for one that genuinely cannot reach
 * any task-write surface.
 */

import type { AgentRow } from './db/types.js';

/** Declared per-agent access to the surfaces that can perform task writes. */
export interface AgentCapabilities {
  /** Can the agent's harness invoke a local shell (Bash tool)? */
  shell?: boolean;
  /** Can the agent's harness make outbound HTTP requests (WebFetch/fetch/curl)? */
  http?: boolean;
  /** Is the agent wired with the narrow task-lifecycle MCP server (task_get/task_claim/task_done)? */
  taskLifecycleMcp?: boolean;
}

export type TaskWriteRoute = 'http' | 'mcp' | 'none';

export interface TaskWriteCapabilityResult {
  capable: boolean;
  route: TaskWriteRoute;
  /** Present only when `capable` is false — the standard preflight failure code. */
  missing_required_capability?: 'task_write';
  reason?: string;
}

function readCapabilities(agent: Pick<AgentRow, 'metadata'>): AgentCapabilities | null {
  const raw = agent.metadata?.capabilities;
  if (!raw || typeof raw !== 'object') return null;
  return raw as AgentCapabilities;
}

/**
 * Resolve whether a target agent can be dispatched a task at all, and via
 * which route. Called before assignment mutates task state so an
 * incompatible dispatch fails clearly (`missing_required_capability:
 * task_write`) instead of leaving the task `doing`-and-owned with nobody
 * able to claim or complete it.
 */
export function resolveAgentTaskWriteCapability(agent: Pick<AgentRow, 'metadata'>): TaskWriteCapabilityResult {
  const capabilities = readCapabilities(agent);
  if (!capabilities) return { capable: true, route: 'http' };

  const hasShell = capabilities.shell !== false;
  const hasHttp = capabilities.http !== false;
  if (hasShell || hasHttp) return { capable: true, route: 'http' };

  if (capabilities.taskLifecycleMcp === true) {
    return { capable: true, route: 'mcp' };
  }

  return {
    capable: false,
    route: 'none',
    missing_required_capability: 'task_write',
    reason: 'Agent declares no shell/HTTP access and no task-lifecycle MCP server is configured — it cannot claim or complete a dispatched task.',
  };
}
