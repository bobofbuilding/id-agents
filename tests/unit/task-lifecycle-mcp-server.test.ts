// SPDX-License-Identifier: MIT
/**
 * Coverage for the narrow task-lifecycle MCP interface
 * (src/task-lifecycle-mcp-server.ts) — the scoped surface an agent with no
 * shell (Bash) or general-purpose HTTP (WebFetch) tool grant can use to
 * get/claim/complete tasks. `task_create` is deliberately excluded (see the
 * module docstring) — this interface only lets an agent act on work already
 * assigned to it. Exercises both:
 *   - the pure tool handlers directly against a mocked `fetch`
 *   - a real MCP protocol round trip (Client <-> Server over an in-memory
 *     transport) to prove the three tools are actually registered and
 *     reachable by name, the way a spawned agent's tool-calling would use
 *     them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createTaskLifecycleMcpServer,
  taskClaimTool,
  taskDoneTool,
  taskGetTool,
  taskLifecycleMcpServerSpec,
  type TaskLifecycleEnv,
} from '../../src/task-lifecycle-mcp-server.js';

const env: TaskLifecycleEnv = {
  managerUrl: 'http://127.0.0.1:9999',
  agentName: 'no-shell-agent',
  team: 'test-team',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('task-lifecycle-mcp-server pure tool handlers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('taskGetTool sends a GET to /tasks/:ref with the team header, no shell required', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, task: { name: 'my-task', status: 'todo' } }));

    const result = await taskGetTool(env, { task: 'my-task' });

    expect(result).toEqual({ ok: true, task: { name: 'my-task', status: 'todo' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9999/tasks/my-task');
    expect(init.method).toBe('GET');
    expect(init.headers['X-Id-Team']).toBe('test-team');
  });

  it('taskClaimTool posts to /tasks/:ref/claim with agent_id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, task: { name: 'my-task', status: 'doing' } }));

    const result = await taskClaimTool(env, { task: 'my-task' });

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9999/tasks/my-task/claim');
    expect(JSON.parse(init.body)).toEqual({ agent_id: 'no-shell-agent' });
  });

  it('taskDoneTool posts to /tasks/:ref/done and surfaces manager errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'not_owner' }));

    const result = await taskDoneTool(env, { task: 'my-task', summary: 'done' });

    expect(result).toEqual({ ok: false, error: 'not_owner' });
  });

  it('URL-encodes task refs containing special characters', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, task: {} }));

    await taskClaimTool(env, { task: '#abc123 def' });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9999/tasks/%23abc123%20def/claim');
  });
});

describe('task-lifecycle-mcp-server MCP protocol round trip', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes exactly the three scoped tools and routes a real tool call through to the manager API', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, task: { name: 'my-task', status: 'doing' } }));

    const server = createTaskLifecycleMcpServer(env);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['task_claim', 'task_done', 'task_get']);

      const callResult = await client.callTool({ name: 'task_claim', arguments: { task: 'my-task' } });
      const content = (callResult.content as Array<{ type: string; text: string }>)[0];
      expect(JSON.parse(content.text)).toEqual({ ok: true, task: { name: 'my-task', status: 'doing' } });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:9999/tasks/my-task/claim',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('taskLifecycleMcpServerSpec', () => {
  it('builds a stdio McpServerSpec that injects MANAGER_URL/AGENT_NAME for the spawned agent, not a shell/HTTP tool grant', () => {
    const spec = taskLifecycleMcpServerSpec('/repo/dist/task-lifecycle-mcp-server.js', {
      agentName: 'no-shell-agent',
      managerUrl: 'http://127.0.0.1:9999',
      team: 'test-team',
    });

    expect(spec.transport).toBe('stdio');
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual(['/repo/dist/task-lifecycle-mcp-server.js']);
    expect(spec.env).toEqual({
      MANAGER_URL: 'http://127.0.0.1:9999',
      AGENT_NAME: 'no-shell-agent',
      ID_TEAM: 'test-team',
    });
  });
});
