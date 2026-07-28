// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { request as httpRequest } from 'http';
import { AgentRestServer } from '../../src/claude-agent-server.js';
import { InteractiveAgentServer } from '../../src/interactive-agent-server.js';
import type {
  AgentHarness,
  HarnessMessage,
  HarnessOptions,
  HarnessType,
} from '../../src/harness/index.js';
import {
  MANAGER_AGENT_TOKEN_ENV,
  MANAGER_TASK_RECEIPT_SERVICE,
} from '../../src/manager-worker-auth.js';

class CountingHarness implements AgentHarness {
  readonly type = 'claude-code-cli' as HarnessType;
  readonly prompts: string[] = [];

  async *run(
    prompt: string,
    _options: HarnessOptions,
  ): AsyncGenerator<HarnessMessage> {
    this.prompts.push(prompt);
    yield { type: 'result', result: 'ok' };
  }
}

function workerHeaders(
  bearer: string,
  options: {
    service?: string;
    agentId?: string;
    team?: string;
  } = {},
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${bearer}`,
    'X-Id-Agent': options.agentId ?? 'agent-1',
    'X-Id-Team': options.team ?? 'default',
    ...(options.service !== undefined
      ? { 'X-Id-Service': options.service }
      : {}),
  };
}

async function rawHttpGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method: 'GET',
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          status: response.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

describe('managed AgentRestServer HTTP boundary', () => {
  const workerBearer = 'generation-bound-worker-bearer';
  let originalToken: string | undefined;
  let originalAgentId: string | undefined;
  let originalAgentTeam: string | undefined;
  let server: AgentRestServer | null = null;
  let rootDir = '';
  let workingDir = '';
  let sharedDir = '';
  let baseUrl = '';
  let harness: CountingHarness;

  beforeEach(async () => {
    originalToken = process.env[MANAGER_AGENT_TOKEN_ENV];
    originalAgentId = process.env.ID_AGENT_ID;
    originalAgentTeam = process.env.ID_AGENT_TEAM;
    process.env[MANAGER_AGENT_TOKEN_ENV] = workerBearer;
    process.env.ID_AGENT_ID = 'agent-1';
    process.env.ID_AGENT_TEAM = 'default';

    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-worker-boundary-'));
    workingDir = path.join(rootDir, 'working');
    sharedDir = path.join(rootDir, 'shared');
    fs.mkdirSync(workingDir);
    fs.mkdirSync(sharedDir);
    fs.writeFileSync(path.join(workingDir, 'visible.txt'), 'visible', 'utf8');
    harness = new CountingHarness();
    server = new AgentRestServer({
      agentName: 'managed-worker',
      agentIdentity: { name: 'managed-worker', team: 'default' },
      workingDirectory: workingDir,
      sharedDirectory: sharedDir,
      db: {
        db: {
          queries: {
            upsert: vi.fn(async () => undefined),
          },
          news: {
            add: vi.fn(async () => undefined),
          },
        } as any,
        teamId: 'team-1',
        agentId: 'agent-1',
      },
      harness,
    });
    await server.start(0);
    const httpServer = (server as any).httpServer as {
      address: () => AddressInfo;
    };
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    fs.rmSync(rootDir, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env[MANAGER_AGENT_TOKEN_ENV];
    else process.env[MANAGER_AGENT_TOKEN_ENV] = originalToken;
    if (originalAgentId === undefined) delete process.env.ID_AGENT_ID;
    else process.env.ID_AGENT_ID = originalAgentId;
    if (originalAgentTeam === undefined) delete process.env.ID_AGENT_TEAM;
    else process.env.ID_AGENT_TEAM = originalAgentTeam;
  });

  it('exposes only minimal anonymous liveness and rejects browser or untrusted callers before execution', async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });

    const discovery = await fetch(`${baseUrl}/.well-known/restap.json`);
    expect(discovery.status).toBe(200);
    await expect(discovery.json()).resolves.toEqual({
      restap_version: '1.0',
      status: 'available',
    });

    const browser = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://attacker.example' },
    });
    expect(browser.status).toBe(403);
    await expect(browser.json()).resolves.toMatchObject({
      error: 'browser_origin_forbidden',
    });

    const hostileHost = await rawHttpGet(`${baseUrl}/health`, {
      Host: 'attacker.example',
    });
    expect(hostileHost.status).toBe(403);
    expect(JSON.parse(hostileHost.body)).toMatchObject({
      error: 'loopback_host_required',
    });

    const anonymousTalk = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'do not execute' }),
    });
    expect(anonymousTalk.status).toBe(401);

    const simpleBrowserPost = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.example',
        'Content-Type': 'text/plain',
      },
      body: '{"message":"do not parse or execute"}',
    });
    expect(simpleBrowserPost.status).toBe(403);
    expect(harness.prompts).toHaveLength(0);
  });

  it('binds Manager and self access to the exact worker identity and route matrix', async () => {
    const wrongBearer = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: workerHeaders('peer-worker-bearer', {
        service: MANAGER_TASK_RECEIPT_SERVICE,
      }),
      body: JSON.stringify({ message: 'do not execute' }),
    });
    expect(wrongBearer.status).toBe(401);

    const wrongTeam = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: workerHeaders(workerBearer, {
        service: MANAGER_TASK_RECEIPT_SERVICE,
        team: 'other-team',
      }),
      body: JSON.stringify({ message: 'do not execute' }),
    });
    expect(wrongTeam.status).toBe(403);

    const wrongAgent = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: workerHeaders(workerBearer, {
        service: MANAGER_TASK_RECEIPT_SERVICE,
        agentId: 'agent-2',
      }),
      body: JSON.stringify({ message: 'do not execute' }),
    });
    expect(wrongAgent.status).toBe(403);

    const selfTalk = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: workerHeaders(workerBearer),
      body: JSON.stringify({ message: 'self must not invoke the LLM ingress' }),
    });
    expect(selfTalk.status).toBe(403);

    const selfTalkTo = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: workerHeaders(workerBearer),
      body: JSON.stringify({}),
    });
    expect(selfTalkTo.status).toBe(400);
    const selfNewsTo = await fetch(`${baseUrl}/news-to`, {
      method: 'POST',
      headers: workerHeaders(workerBearer),
      body: JSON.stringify({}),
    });
    expect(selfNewsTo.status).toBe(400);

    const managerHealth = await fetch(`${baseUrl}/health`, {
      headers: workerHeaders(workerBearer, {
        service: MANAGER_TASK_RECEIPT_SERVICE,
      }),
    });
    expect(managerHealth.status).toBe(200);
    await expect(managerHealth.json()).resolves.toMatchObject({
      status: 'ok',
      agent: 'managed-worker',
      agentId: 'agent-1',
      pid: expect.any(Number),
    });

    const managerTalk = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: workerHeaders(workerBearer, {
        service: MANAGER_TASK_RECEIPT_SERVICE,
      }),
      body: JSON.stringify({ message: 'manager-authorized execution' }),
    });
    expect(managerTalk.status).toBe(202);
    await vi.waitFor(() => expect(harness.prompts).toHaveLength(1));
  });

  it('contains managed file reads and writes within explicit real workspace roots', async () => {
    const outsideFile = path.join(rootDir, 'outside-secret.txt');
    fs.writeFileSync(outsideFile, 'outside secret', 'utf8');
    fs.symlinkSync(outsideFile, path.join(workingDir, 'leak.txt'));
    fs.symlinkSync(outsideFile, path.join(workingDir, 'overwrite.txt'));
    const selfHeaders = workerHeaders(workerBearer);

    const listing = await fetch(`${baseUrl}/files/list`, {
      headers: selfHeaders,
    });
    expect(listing.status).toBe(200);
    const listingBody = await listing.json() as {
      files: Array<{ path: string }>;
    };
    expect(listingBody.files.map((file) => file.path)).toContain('visible.txt');
    expect(listingBody.files.map((file) => file.path)).not.toContain('leak.txt');
    expect(JSON.stringify(listingBody)).not.toContain('outside-secret.txt');

    const visible = await fetch(`${baseUrl}/files/visible.txt`, {
      headers: selfHeaders,
    });
    expect(visible.status).toBe(200);
    await expect(visible.text()).resolves.toBe('visible');

    const escapedSymlink = await fetch(`${baseUrl}/files/leak.txt`, {
      headers: selfHeaders,
    });
    expect(escapedSymlink.status).toBe(403);

    const overwriteSymlink = await fetch(`${baseUrl}/files/upload`, {
      method: 'POST',
      headers: selfHeaders,
      body: JSON.stringify({
        filename: 'overwrite.txt',
        content: 'overwrite attempt',
      }),
    });
    expect(overwriteSymlink.status).toBe(403);
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside secret');
  });
});

describe('InteractiveAgentServer mode parity', () => {
  const workerBearer = 'interactive-generation-bearer';
  let originalToken: string | undefined;
  let originalAgentId: string | undefined;
  let originalAgentTeam: string | undefined;
  let managed: InteractiveAgentServer | null = null;
  let standalone: InteractiveAgentServer | null = null;

  beforeEach(() => {
    originalToken = process.env[MANAGER_AGENT_TOKEN_ENV];
    originalAgentId = process.env.ID_AGENT_ID;
    originalAgentTeam = process.env.ID_AGENT_TEAM;
    process.env.ID_AGENT_ID = 'agent-1';
    process.env.ID_AGENT_TEAM = 'default';
  });

  afterEach(async () => {
    await managed?.close();
    await standalone?.close();
    managed = null;
    standalone = null;
    if (originalToken === undefined) delete process.env[MANAGER_AGENT_TOKEN_ENV];
    else process.env[MANAGER_AGENT_TOKEN_ENV] = originalToken;
    if (originalAgentId === undefined) delete process.env.ID_AGENT_ID;
    else process.env.ID_AGENT_ID = originalAgentId;
    if (originalAgentTeam === undefined) delete process.env.ID_AGENT_TEAM;
    else process.env.ID_AGENT_TEAM = originalAgentTeam;
  });

  it('applies the same managed principal boundary while preserving standalone routes', async () => {
    process.env[MANAGER_AGENT_TOKEN_ENV] = workerBearer;
    managed = new InteractiveAgentServer('managed-human', 0);
    await managed.start();
    const managedPort = ((managed as any).httpServer.address() as AddressInfo).port;
    const managedUrl = `http://127.0.0.1:${managedPort}`;

    const discovery = await fetch(`${managedUrl}/.well-known/restap.json`);
    expect(discovery.status).toBe(200);
    await expect(discovery.json()).resolves.toEqual({
      restap_version: '1.0',
      status: 'available',
    });

    const browser = await fetch(`${managedUrl}/talk`, {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.example',
        'Content-Type': 'text/plain',
      },
      body: '{"message":"do not enqueue"}',
    });
    expect(browser.status).toBe(403);

    const anonymous = await fetch(`${managedUrl}/talk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'do not enqueue' }),
    });
    expect(anonymous.status).toBe(401);

    const selfTalk = await fetch(`${managedUrl}/talk`, {
      method: 'POST',
      headers: workerHeaders(workerBearer),
      body: JSON.stringify({ message: 'self cannot inject human work' }),
    });
    expect(selfTalk.status).toBe(403);

    const managerTalk = await fetch(`${managedUrl}/talk`, {
      method: 'POST',
      headers: workerHeaders(workerBearer, {
        service: MANAGER_TASK_RECEIPT_SERVICE,
      }),
      body: JSON.stringify({ message: 'manager-authorized human work' }),
    });
    expect(managerTalk.status).toBe(202);
    expect(await managed.getPendingQueries()).toHaveLength(1);

    await managed.close();
    managed = null;
    delete process.env[MANAGER_AGENT_TOKEN_ENV];
    standalone = new InteractiveAgentServer('standalone-human', 0);
    await standalone.start();
    const standalonePort = (
      (standalone as any).httpServer.address() as AddressInfo
    ).port;
    const standaloneRes = await fetch(
      `http://127.0.0.1:${standalonePort}/talk`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'legacy standalone request' }),
      },
    );
    expect(standaloneRes.status).toBe(202);
    expect(await standalone.getPendingQueries()).toHaveLength(1);
  });
});
