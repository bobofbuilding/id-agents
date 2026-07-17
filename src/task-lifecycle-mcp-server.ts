// SPDX-License-Identifier: MIT
/**
 * Narrow task-lifecycle interface for agents that have no shell (Bash) or
 * general-purpose HTTP (WebFetch/curl) tool grant. Exposes exactly three
 * scoped MCP tools — task_get, task_claim, task_done — each backed by a
 * single call into the manager's existing REST task API
 * (`GET /tasks/:ref`, `POST /tasks/:ref/claim`, `POST /tasks/:ref/done`).
 *
 * `task_create` is deliberately excluded: the acceptance bar for this
 * interface is "an assigned agent can claim and finish its own work," not
 * "a restricted agent can create arbitrary tasks." Adding create authority
 * here would be a separate, separately-authorized surface.
 *
 * The model only ever sees these three fixed operations; the network call
 * happens inside this trusted server process, not through a general
 * shell/fetch tool grant. Attach it to an agent's `mcpServers` (see
 * `taskLifecycleMcpServerSpec`) when `resolveAgentTaskWriteCapability`
 * (see ./task-capability.ts) resolves that agent to route 'mcp'.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import type { McpServerSpec } from './harness/types.js';

export interface TaskLifecycleEnv {
  managerUrl: string;
  agentName: string;
  team?: string;
}

export interface TaskLifecycleToolResult {
  ok: boolean;
  task?: unknown;
  error?: string;
}

function envFromProcess(): TaskLifecycleEnv {
  const managerUrl = process.env.MANAGER_URL || process.env.ID_MANAGER_URL;
  const agentName = process.env.AGENT_NAME || process.env.ID_AGENT_NAME;
  if (!managerUrl) throw new Error('MANAGER_URL is required for the task-lifecycle MCP server');
  if (!agentName) throw new Error('AGENT_NAME is required for the task-lifecycle MCP server');
  return { managerUrl, agentName, team: process.env.ID_TEAM || process.env.TEAM };
}

async function callManager(
  env: TaskLifecycleEnv,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.team) headers['X-Id-Team'] = env.team;
  const res = await fetch(`${env.managerUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON error body from an upstream failure — fall through with no data.
  }
  return { ok: res.ok, data };
}

export async function taskGetTool(
  env: TaskLifecycleEnv,
  input: { task: string },
): Promise<TaskLifecycleToolResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.team) headers['X-Id-Team'] = env.team;
  const res = await fetch(
    `${env.managerUrl.replace(/\/+$/, '')}/tasks/${encodeURIComponent(input.task)}`,
    { method: 'GET', headers },
  );
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON error body from an upstream failure — fall through with no data.
  }
  return res.ok ? { ok: true, task: data?.task } : { ok: false, error: data?.error || 'task_get_failed' };
}

export async function taskClaimTool(
  env: TaskLifecycleEnv,
  input: { task: string },
): Promise<TaskLifecycleToolResult> {
  const { ok, data } = await callManager(env, `/tasks/${encodeURIComponent(input.task)}/claim`, {
    agent_id: env.agentName,
  });
  return ok ? { ok: true, task: data?.task } : { ok: false, error: data?.error || 'task_claim_failed' };
}

export async function taskDoneTool(
  env: TaskLifecycleEnv,
  input: { task: string; summary?: string; used_source_ids?: string[] },
): Promise<TaskLifecycleToolResult> {
  const { ok, data } = await callManager(env, `/tasks/${encodeURIComponent(input.task)}/done`, {
    agent_id: env.agentName,
    summary: input.summary,
    used_source_ids: input.used_source_ids,
  });
  return ok ? { ok: true, task: data?.task } : { ok: false, error: data?.error || 'task_done_failed' };
}

/** Build the in-process MCP server object. Exported separately from `main()` so tests can register/inspect it without spawning a stdio transport. */
export function createTaskLifecycleMcpServer(env: TaskLifecycleEnv): McpServer {
  const server = new McpServer({ name: 'task-lifecycle', version: '1.0.0' });

  server.registerTool(
    'task_get',
    {
      description: 'Look up a task by name or #shortid. Requires no shell or HTTP tool access.',
      inputSchema: { task: z.string().min(1) },
    },
    async (input) => {
      const result = await taskGetTool(env, input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'task_claim',
    {
      description: 'Claim a todo task by name or #shortid.',
      inputSchema: { task: z.string().min(1) },
    },
    async (input) => {
      const result = await taskClaimTool(env, input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'task_done',
    {
      description: 'Mark a task this agent owns as done.',
      inputSchema: {
        task: z.string().min(1),
        summary: z.string().optional(),
        used_source_ids: z.array(z.string()).optional(),
      },
    },
    async (input) => {
      const result = await taskDoneTool(env, input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  return server;
}

/**
 * Build the `McpServerSpec` the manager attaches to `HarnessOptions.mcpServers`
 * for an agent whose capability preflight resolved to route 'mcp'.
 * `entrypoint` is the compiled path to this file (e.g. `dist/task-lifecycle-mcp-server.js`).
 */
export function taskLifecycleMcpServerSpec(
  entrypoint: string,
  env: { agentName: string; managerUrl: string; team?: string },
): McpServerSpec {
  return {
    name: 'task-lifecycle',
    transport: 'stdio',
    command: process.execPath,
    args: [entrypoint],
    env: {
      MANAGER_URL: env.managerUrl,
      AGENT_NAME: env.agentName,
      ...(env.team ? { ID_TEAM: env.team } : {}),
    },
  };
}

async function main(): Promise<void> {
  const env = envFromProcess();
  const server = createTaskLifecycleMcpServer(env);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMainModule = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((err) => {
    console.error(`[task-lifecycle-mcp] fatal: ${err?.message || err}`);
    process.exit(1);
  });
}
